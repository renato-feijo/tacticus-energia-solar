import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db,
  getConfiguracoes,
  salvarConfiguracoes,
  getClientes,
  salvarCliente,
  obterRegrasCalculoCliente,
  registrarImportacaoNeoenergia,
  recalcularPeriodo,
  inicializarDadosSeed,
} from './db.mjs';
import {
  extrairTextoDePdfBuffer,
  parseResumoNeoenergia,
  formatarUC15,
  normalizarUC,
} from './neoenergiaParser.mjs';
import {
  calcularFaturamento,
  gerarCardSvg,
  gerarFaturaDetalhadaSvg,
  converterSvgBuffer,
} from './cardGenerator.mjs';
import {
  listarEmailsNeoenergiaGmail,
  baixarEExtrairPdfGmail,
  gerarGoogleOAuthUrl,
  trocarCodigoOAuthGoogle,
  sincronizarClientesGoogleSheets,
  enviarMidiaEvolutionWhatsApp,
} from './integrations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3456);

// Inicializa dados iniciais (7 clientes + relatório Out/2026) na primeira execução
inicializarDadosSeed();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Payload excede o limite permitido de 25MB.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function montarDadosFatura(uc, chavePeriodo) {
  const uc15 = formatarUC15(uc);
  const configs = getConfiguracoes();
  const cliente =
    db.prepare('SELECT * FROM clientes WHERE uc = ? OR cod_cliente = ? LIMIT 1').get(uc15, normalizarUC(uc)) || {
      uc: uc15,
      cod_cliente: normalizarUC(uc),
      nome_cliente: `Cliente UC ${normalizarUC(uc)}`,
      localidade: 'Pernambuco',
      conta_contrato: '',
      medidor_atual: '',
      saldo_credito_acumulado: 0,
      whatsapp: '',
    };

  const reg = chavePeriodo
    ? db
        .prepare('SELECT * FROM historico_consumo WHERE uc = ? AND chave_periodo = ? LIMIT 1')
        .get(cliente.uc, chavePeriodo)
    : db
        .prepare('SELECT * FROM historico_consumo WHERE uc = ? ORDER BY chave_periodo DESC LIMIT 1')
        .get(cliente.uc);

  if (!reg) {
    throw new Error(`Nenhum registro de consumo encontrado para a UC ${cliente.uc} no período solicitado.`);
  }

  const historico = db
    .prepare('SELECT * FROM historico_consumo WHERE uc = ? ORDER BY chave_periodo ASC')
    .all(cliente.uc);

  const regrasCli = obterRegrasCalculoCliente(cliente, configs);

  const kwhBase =
    regrasCli.baseCalculo === 'kwh_compensado' || regrasCli.baseCalculo === 'compensado'
      ? Number(reg.kwh_compensado ?? reg.energia_consumida ?? 0)
      : Number(reg.energia_consumida ?? 0);

  const calc = calcularFaturamento({
    consumoKwh: kwhBase,
    bandeira: reg.bandeira || configs.bandeira_padrao || 'AMARELA',
    periodo: reg.periodo_label || reg.periodo,
    tarifaNeoenergia: regrasCli.tarifaNeoenergia,
    tarifaTacticus: regrasCli.tarifaTacticus,
    adicionalVerde: regrasCli.adicionalVerde,
    adicionalAmarela: regrasCli.adicionalAmarela,
    adicionalVermelha: regrasCli.adicionalVermelha,
  });

  const dadosCard = {
    ...reg,
    ...calc,
    Periodo: reg.periodo_label || reg.periodo,
    Nome_Cliente: cliente.nome_cliente,
    Localidade: cliente.localidade || 'Pernambuco',
    Consumo_kWh: kwhBase,
    Valor_Calculado: calc.valor_neoenergia,
    Valor_Com_Desconto: calc.valor_tacticus,
    Bandeira_Tarifaria: calc.bandeira,
    Cor_Bandeira: calc.cor_bandeira,
    Cor_Texto_Bandeira: calc.cor_texto_bandeira,
    Observacao_Bandeira: calc.observacao_bandeira,
    Chave_Pix: regrasCli.chavePix,
    Telefone_Contato: regrasCli.telefoneContato,
    uc: cliente.uc,
    cod_cliente: cliente.cod_cliente,
    conta_contrato: cliente.conta_contrato,
    medidor: reg.medidor || cliente.medidor_atual,
    saldo_credito_acumulado: cliente.saldo_credito_acumulado,
    whatsapp: cliente.whatsapp,
  };

  return {
    cliente,
    registro: reg,
    historico,
    configs,
    configTarifas: {
      tarifaNeoenergia: regrasCli.tarifaNeoenergia,
      tarifaTacticus: regrasCli.tarifaTacticus,
      adicionalVerde: regrasCli.adicionalVerde,
      adicionalAmarela: regrasCli.adicionalAmarela,
      adicionalVermelha: regrasCli.adicionalVermelha,
    },
    dadosCard,
  };
}

const server = createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    const pathname = urlObj.pathname;

    // ─── API ROUTES ────────────────────────────────────────────────────────────
    if (pathname === '/api/overview' && req.method === 'GET') {
      const periodoParam = urlObj.searchParams.get('chave_periodo');
      const periodosRows = db
        .prepare('SELECT DISTINCT chave_periodo, periodo, periodo_label, bandeira FROM historico_consumo ORDER BY chave_periodo DESC')
        .all();

      const periodosMap = new Map();
      for (const p of periodosRows) {
        if (!periodosMap.has(p.chave_periodo)) {
          periodosMap.set(p.chave_periodo, p);
        }
      }
      const periodos = Array.from(periodosMap.values());
      const chaveSelecionada = periodoParam || periodos[0]?.chave_periodo || '';

      const ultimaImportacao = db
        .prepare('SELECT * FROM importacoes ORDER BY id DESC LIMIT 1')
        .get();

      const importacoesRecentes = db
        .prepare('SELECT * FROM importacoes ORDER BY id DESC LIMIT 15')
        .all();

      // Evolução agregada por mês
      const evolucaoMensal = db
        .prepare(`
          SELECT
            chave_periodo,
            periodo,
            periodo_label,
            SUM(energia_consumida) AS total_consumido,
            SUM(energia_injetada) AS total_injetado,
            SUM(kwh_compensado) AS total_compensado,
            SUM(valor_neoenergia) AS total_valor_neoenergia,
            SUM(valor_tacticus) AS total_valor_tacticus,
            SUM(economia_reais) AS total_economia,
            COUNT(*) AS qtd_unidades
          FROM historico_consumo
          GROUP BY chave_periodo
          ORDER BY chave_periodo ASC
        `)
        .all();

      // Faturas do período selecionado cruzadas com clientes
      const faturasPeriodoRaw = db
        .prepare(`
          SELECT
            c.id AS cliente_id,
            c.uc,
            c.cod_cliente,
            c.conta_contrato,
            c.prioridade,
            c.nome_cliente,
            c.whatsapp,
            c.localidade,
            c.tipo_unidade,
            c.medidor_atual,
            c.medidor_antigo,
            c.saldo_credito_acumulado,
            c.tarifa_neoenergia,
            c.tarifa_conta_1,
            c.tarifa_conta_2,
            c.tarifa_conta_3,
            c.tarifa_tacticus,
            c.base_calculo,
            c.chave_pix,
            c.telefone_contato,
            c.status_envio,
            c.ativo,
            h.id AS historico_id,
            h.chave_periodo,
            h.periodo,
            h.periodo_label,
            h.energia_consumida,
            h.energia_injetada,
            h.energia_faturada,
            h.kwh_compensado,
            h.credito_mes,
            h.medidor,
            h.leitura_de,
            h.leitura_ate,
            h.bandeira,
            h.valor_neoenergia,
            h.valor_tacticus,
            h.economia_reais,
            h.status_fatura,
            h.enviado_whatsapp_em,
            h.pago_em
          FROM clientes c
          LEFT JOIN historico_consumo h
            ON h.uc = c.uc AND h.chave_periodo = ?
          ORDER BY c.prioridade ASC, c.nome_cliente ASC
        `)
        .all(chaveSelecionada);

      const cfgAtuais = getConfiguracoes();
      const faturasPeriodo = faturasPeriodoRaw.map(f => {
        const rCli = obterRegrasCalculoCliente(f, cfgAtuais);
        return {
          ...f,
          tarifa_neoenergia_efetiva: rCli.tarifaNeoenergia,
          tarifa_tacticus_efetiva: rCli.tarifaTacticus,
          chave_pix_efetiva: rCli.chavePix,
          base_calculo_efetiva: rCli.baseCalculo,
        };
      });

      const totaisHistorico = db
        .prepare(`
          SELECT
            SUM(energia_consumida) AS consumo_acumulado,
            SUM(energia_injetada) AS injetado_acumulado,
            SUM(kwh_compensado) AS compensado_acumulado,
            SUM(valor_neoenergia) AS neoenergia_acumulado,
            SUM(valor_tacticus) AS faturamento_tacticus_acumulado,
            SUM(economia_reais) AS economia_clientes_acumulada
          FROM historico_consumo
        `)
        .get();

      return sendJson(res, 200, {
        chaveSelecionada,
        periodos,
        ultimaImportacao,
        importacoesRecentes,
        evolucaoMensal,
        faturasPeriodo,
        totaisHistorico,
        configuracoes: cfgAtuais,
      });
    }

    if (pathname === '/api/historico' && req.method === 'GET') {
      const uc = urlObj.searchParams.get('uc');
      const chavePeriodo = urlObj.searchParams.get('chave_periodo');

      let sql = `
        SELECT
          h.*,
          c.nome_cliente,
          c.localidade,
          c.conta_contrato,
          c.prioridade,
          c.whatsapp,
          c.tipo_unidade,
          c.saldo_credito_acumulado
        FROM historico_consumo h
        LEFT JOIN clientes c ON c.uc = h.uc
        WHERE 1=1
      `;
      const params = [];
      if (uc) {
        sql += ' AND (h.uc = ? OR h.cod_cliente = ?)';
        params.push(formatarUC15(uc), normalizarUC(uc));
      }
      if (chavePeriodo) {
        sql += ' AND h.chave_periodo = ?';
        params.push(chavePeriodo);
      }
      sql += ' ORDER BY h.chave_periodo DESC, c.prioridade ASC';

      const registros = db.prepare(sql).all(...params);
      return sendJson(res, 200, { registros });
    }

    if (pathname === '/api/historico/atualizar' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { id, energia_consumida, kwh_compensado, bandeira, status_fatura } = body;
      const row = db.prepare('SELECT * FROM historico_consumo WHERE id = ?').get(Number(id));
      if (!row) {
        return sendJson(res, 404, { error: 'Registro não encontrado.' });
      }

      const novoConsumo =
        energia_consumida !== undefined ? Number(energia_consumida) : row.energia_consumida;
      const novoCompensado =
        kwh_compensado !== undefined ? Number(kwh_compensado) : row.kwh_compensado;
      const novaBandeira = bandeira ? String(bandeira).toUpperCase() : row.bandeira;
      const novoStatus = status_fatura ? String(status_fatura).toUpperCase() : row.status_fatura;

      const configs = getConfiguracoes();
      const cli = db.prepare('SELECT * FROM clientes WHERE uc = ?').get(row.uc);
      const regrasCli = obterRegrasCalculoCliente(cli, configs);

      const kwhBase =
        regrasCli.baseCalculo === 'kwh_compensado' || regrasCli.baseCalculo === 'compensado'
          ? novoCompensado
          : novoConsumo;

      const calc = calcularFaturamento({
        consumoKwh: kwhBase,
        bandeira: novaBandeira,
        periodo: row.periodo_label || row.periodo,
        tarifaNeoenergia: regrasCli.tarifaNeoenergia,
        tarifaTacticus: regrasCli.tarifaTacticus,
        adicionalVerde: regrasCli.adicionalVerde,
        adicionalAmarela: regrasCli.adicionalAmarela,
        adicionalVermelha: regrasCli.adicionalVermelha,
      });

      const pagoEm = novoStatus === 'PAGA' ? new Date().toISOString() : row.pago_em;

      db.prepare(`
        UPDATE historico_consumo
        SET energia_consumida = ?,
            kwh_compensado = ?,
            bandeira = ?,
            valor_neoenergia = ?,
            valor_tacticus = ?,
            economia_reais = ?,
            status_fatura = ?,
            pago_em = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        novoConsumo,
        novoCompensado,
        novaBandeira,
        calc.valor_neoenergia,
        calc.valor_tacticus,
        calc.economia_reais,
        novoStatus,
        pagoEm,
        Number(id)
      );

      return sendJson(res, 200, {
        ok: true,
        registro: db.prepare('SELECT * FROM historico_consumo WHERE id = ?').get(Number(id)),
      });
    }

    if (pathname === '/api/periodo/recalcular' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { chave_periodo, bandeira } = body;
      if (bandeira) {
        salvarConfiguracoes({ bandeira_padrao: String(bandeira).toUpperCase() });
      }
      const total = recalcularPeriodo(chave_periodo || null, bandeira || null);
      return sendJson(res, 200, { ok: true, atualizados: total });
    }

    if (pathname === '/api/fatura/preview' && req.method === 'GET') {
      const uc = urlObj.searchParams.get('uc');
      const chavePeriodo = urlObj.searchParams.get('chave_periodo');
      const tipo = urlObj.searchParams.get('tipo') || 'card'; // 'card' | 'detalhada'
      const formato = urlObj.searchParams.get('formato') || 'svg'; // 'svg' | 'png' | 'pdf'
      const download = urlObj.searchParams.get('download') === '1';

      if (!uc) {
        return sendJson(res, 400, { error: 'Parâmetro uc é obrigatório.' });
      }

      const { dadosCard, historico, configTarifas, cliente, registro } = montarDadosFatura(
        uc,
        chavePeriodo
      );

      const svg =
        tipo === 'detalhada'
          ? gerarFaturaDetalhadaSvg(dadosCard, historico, configTarifas)
          : gerarCardSvg(dadosCard);

      const safeNome = String(cliente.nome_cliente || cliente.cod_cliente)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_');
      const safePeriodo = String(registro.chave_periodo || 'atual');
      const prefixo = tipo === 'detalhada' ? 'Fatura_Solar' : 'Card_Solar';

      if (formato === 'svg') {
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(download
            ? {
                'Content-Disposition': `attachment; filename="${prefixo}_${safeNome}_${safePeriodo}.svg"`,
              }
            : {}),
        });
        return res.end(svg);
      }

      const outBuf = converterSvgBuffer(svg, formato === 'pdf' ? 'pdf' : 'png');
      const mime = formato === 'pdf' ? 'application/pdf' : 'image/png';
      const ext = formato === 'pdf' ? 'pdf' : 'png';

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': outBuf.length,
        'Cache-Control': 'no-store',
        ...(download
          ? {
              'Content-Disposition': `attachment; filename="${prefixo}_${safeNome}_${safePeriodo}.${ext}"`,
            }
          : {}),
      });
      return res.end(outBuf);
    }

    if (pathname === '/api/importar/pdf' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { pdfBase64, textoBruto, arquivoNome, bandeira } = body;

      let rawText = textoBruto || '';
      if (pdfBase64) {
        const cleanB64 = String(pdfBase64).replace(/^data:application\/pdf;base64,/i, '');
        const pdfBuf = Buffer.from(cleanB64, 'base64');
        rawText = extrairTextoDePdfBuffer(pdfBuf);
      }

      if (!rawText || !rawText.trim()) {
        return sendJson(res, 400, {
          error: 'Nenhum conteúdo de texto pôde ser extraído do PDF enviado.',
        });
      }

      const parsed = parseResumoNeoenergia(rawText, getClientes());
      if (!parsed.registros || parsed.registros.length === 0) {
        return sendJson(res, 422, {
          error:
            'O PDF foi lido, mas não foram encontrados registros de consumo no formato de Faturamento Microgeração da Neoenergia.',
          rawTextPreview: rawText.slice(0, 600),
        });
      }

      const resultado = registrarImportacaoNeoenergia({
        parsed,
        origem: pdfBase64 ? 'UPLOAD_PDF' : 'TEXTO_MANUAL',
        arquivoNome: arquivoNome || 'Resumo_Neoenergia.pdf',
        bandeiraVigencia: bandeira || null,
      });

      return sendJson(res, 200, {
        ok: true,
        resultado,
        parsed,
      });
    }

    if (pathname === '/api/gmail/emails' && req.method === 'GET') {
      const q = urlObj.searchParams.get('q') || null;
      const emails = await listarEmailsNeoenergiaGmail(q, 10);
      return sendJson(res, 200, { emails });
    }

    if (pathname === '/api/gmail/importar' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let { messageId, attachmentId, bandeira } = body;

      if (!messageId) {
        const lista = await listarEmailsNeoenergiaGmail(null, 5);
        const comPdf = lista.find(e => e.anexosPdf && e.anexosPdf.length > 0);
        if (!comPdf) {
          return sendJson(res, 404, {
            error: 'Nenhum e-mail da Neoenergia com anexo PDF foi encontrado na busca do Gmail.',
          });
        }
        messageId = comPdf.id;
        attachmentId = comPdf.anexosPdf[0].attachmentId;
      }

      const extraido = await baixarEExtrairPdfGmail(messageId, attachmentId);
      const resultado = registrarImportacaoNeoenergia({
        parsed: extraido.parsed,
        origem: 'GMAIL',
        arquivoNome: extraido.filename,
        gmailMessageId: extraido.messageId,
        assuntoEmail: extraido.subject,
        bandeiraVigencia: bandeira || null,
      });

      return sendJson(res, 200, {
        ok: true,
        arquivo: extraido.filename,
        assunto: extraido.subject,
        resultado,
      });
    }

    if (pathname === '/api/gmail/oauth-url' && req.method === 'GET') {
      const redirectUri = `${urlObj.origin}/api/gmail/oauth-callback`;
      const authUrl = gerarGoogleOAuthUrl(redirectUri);
      return sendJson(res, 200, { authUrl, redirectUri });
    }

    if (pathname === '/api/gmail/oauth-callback' && req.method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2>Código OAuth não recebido.</h2>');
      }
      const redirectUri = `${urlObj.origin}/api/gmail/oauth-callback`;
      await trocarCodigoOAuthGoogle(code, redirectUri);
      res.writeHead(302, { Location: '/?gmail_connected=1' });
      return res.end();
    }

    if (pathname === '/api/clientes' && req.method === 'GET') {
      return sendJson(res, 200, { clientes: getClientes() });
    }

    if (pathname === '/api/clientes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const clienteSalvo = salvarCliente(body);
      recalcularPeriodo(null, null);
      return sendJson(res, 200, { ok: true, cliente: clienteSalvo });
    }

    if (pathname === '/api/clientes/excluir' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.uc) return sendJson(res, 400, { error: 'Informe a UC do cliente.' });
      db.prepare('DELETE FROM clientes WHERE uc = ?').run(formatarUC15(body.uc));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/clientes/sync-sheets' && req.method === 'POST') {
      const syncRes = await sincronizarClientesGoogleSheets();
      return sendJson(res, 200, { ok: true, ...syncRes, clientes: getClientes() });
    }

    if (pathname === '/api/whatsapp/enviar' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { uc, chave_periodo, tipo = 'card', formato = 'png', legenda } = body;
      const { dadosCard, historico, configTarifas, cliente, registro } = montarDadosFatura(
        uc,
        chave_periodo
      );

      const svg =
        tipo === 'detalhada'
          ? gerarFaturaDetalhadaSvg(dadosCard, historico, configTarifas)
          : gerarCardSvg(dadosCard);

      const fmt = formato === 'pdf' ? 'pdf' : 'png';
      const bufferMidia = converterSvgBuffer(svg, fmt);
      const mimeType = fmt === 'pdf' ? 'application/pdf' : 'image/png';
      const nomeArquivo = `${tipo === 'detalhada' ? 'fatura' : 'card'}-${cliente.cod_cliente}-${registro.chave_periodo}.${fmt}`;

      const evoResp = await enviarMidiaEvolutionWhatsApp({
        numeroWhatsApp: cliente.whatsapp,
        bufferMidia,
        nomeArquivo,
        mimeType,
        legenda,
      });

      db.prepare(`
        UPDATE historico_consumo
        SET status_fatura = 'ENVIADA',
            enviado_whatsapp_em = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(registro.id);

      db.prepare(`
        UPDATE clientes
        SET status_envio = 'ENVIADO',
            updated_at = CURRENT_TIMESTAMP
        WHERE uc = ?
      `).run(cliente.uc);

      return sendJson(res, 200, {
        ok: true,
        cliente: cliente.nome_cliente,
        whatsapp: cliente.whatsapp,
        periodo: registro.periodo_label,
        evolution: evoResp,
      });
    }

    if (pathname === '/api/exportar/csv' && req.method === 'GET') {
      const rows = db
        .prepare(`
          SELECT
            h.chave_periodo AS Periodo_Chave,
            h.periodo_label AS Periodo,
            h.uc AS UC,
            h.cod_cliente AS Cod_Cliente,
            c.nome_cliente AS Nome_Cliente,
            c.localidade AS Localidade,
            h.medidor AS Medidor,
            h.leitura_de AS Leitura_Anterior,
            h.leitura_ate AS Leitura_Atual,
            h.energia_consumida AS Energia_Consumida_kWh,
            h.energia_injetada AS Energia_Injetada_kWh,
            h.energia_faturada AS Energia_Faturada_kWh,
            h.kwh_compensado AS kWh_Compensado,
            h.credito_mes AS Credito_Mes_kWh,
            h.bandeira AS Bandeira,
            h.valor_neoenergia AS Valor_Neoenergia_R$,
            h.valor_tacticus AS Valor_Solar_Tacticus_R$,
            h.economia_reais AS Economia_R$,
            h.status_fatura AS Status_Fatura
          FROM historico_consumo h
          LEFT JOIN clientes c ON c.uc = h.uc
          ORDER BY h.chave_periodo DESC, c.prioridade ASC
        `)
        .all();

      const headers = Object.keys(rows[0] || {});
      const csvLines = [
        headers.join(';'),
        ...rows.map(r =>
          headers
            .map(k => {
              const v = r[k] ?? '';
              return typeof v === 'number' ? String(v).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`;
            })
            .join(';')
        ),
      ];

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="historico_consumo_energia_solar.csv"',
      });
      return res.end('\uFEFF' + csvLines.join('\r\n'));
    }

    if (pathname === '/api/configuracoes' && req.method === 'GET') {
      return sendJson(res, 200, { configuracoes: getConfiguracoes() });
    }

    if (pathname === '/api/configuracoes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const novas = salvarConfiguracoes(body);
      recalcularPeriodo(null, null);
      return sendJson(res, 200, { ok: true, configuracoes: novas });
    }

    // ─── STATIC ASSETS ─────────────────────────────────────────────────────────
    const cleanPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = join(PUBLIC_DIR, cleanPath);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return res.end(content);
    }

    return sendJson(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    console.error('[API Error]', err);
    return sendJson(res, 500, { error: err.message || 'Erro interno no servidor.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`☀️ Tacticus Energia Solar rodando em http://localhost:${PORT}`);
});

