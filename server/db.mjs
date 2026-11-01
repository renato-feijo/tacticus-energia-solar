import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_NEOENERGIA_REPORT_TEXT, INITIAL_CLIENTS } from './sampleReportText.mjs';
import { parseResumoNeoenergia, normalizarUC, formatarUC15 } from './neoenergiaParser.mjs';
import { calcularFaturamento } from './cardGenerator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'energia_solar.sqlite');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uc TEXT UNIQUE NOT NULL,
    cod_cliente TEXT NOT NULL,
    conta_contrato TEXT DEFAULT '',
    prioridade INTEGER DEFAULT 0,
    nome_cliente TEXT NOT NULL,
    whatsapp TEXT DEFAULT '',
    localidade TEXT DEFAULT '',
    tipo_unidade TEXT DEFAULT 'BENEFICIARIA',
    medidor_atual TEXT DEFAULT '',
    medidor_antigo TEXT DEFAULT '',
    saldo_credito_acumulado REAL DEFAULT 0,
    tarifa_personalizada REAL DEFAULT NULL,
    tarifa_neoenergia REAL DEFAULT 1.11,
    tarifa_conta_1 REAL DEFAULT NULL,
    tarifa_conta_2 REAL DEFAULT NULL,
    tarifa_conta_3 REAL DEFAULT NULL,
    tarifa_tacticus REAL DEFAULT 0.90,
    base_calculo TEXT DEFAULT 'energia_consumida',
    chave_pix TEXT DEFAULT 'contato@renatofeijo.com.br',
    telefone_contato TEXT DEFAULT '(81) 99950-3231',
    status_envio TEXT DEFAULT 'ENVIAR',
    ativo INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS importacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origem TEXT NOT NULL,
    arquivo_nome TEXT DEFAULT '',
    gmail_message_id TEXT DEFAULT '',
    assunto_email TEXT DEFAULT '',
    titular_relatorio TEXT DEFAULT '',
    conta_contrato_titular TEXT DEFAULT '',
    periodo_descricao TEXT DEFAULT '',
    total_injetado REAL DEFAULT 0,
    total_compensado REAL DEFAULT 0,
    saldo_acumulado REAL DEFAULT 0,
    proximo_saldo_expirar REAL DEFAULT 0,
    ciclo_expirar TEXT DEFAULT '',
    qtd_registros_importados INTEGER DEFAULT 0,
    qtd_registros_atualizados INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS historico_consumo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uc TEXT NOT NULL,
    cod_cliente TEXT NOT NULL,
    chave_periodo TEXT NOT NULL,
    periodo TEXT NOT NULL,
    periodo_label TEXT NOT NULL,
    energia_consumida REAL DEFAULT 0,
    energia_injetada REAL DEFAULT 0,
    energia_faturada REAL DEFAULT 30,
    kwh_compensado REAL DEFAULT 0,
    credito_mes REAL DEFAULT 0,
    medidor TEXT DEFAULT '',
    leitura_de REAL DEFAULT NULL,
    leitura_ate REAL DEFAULT NULL,
    injetado_acumulado REAL DEFAULT NULL,
    saldo_mes_anterior REAL DEFAULT NULL,
    bandeira TEXT DEFAULT 'AMARELA',
    valor_neoenergia REAL DEFAULT 0,
    valor_tacticus REAL DEFAULT 0,
    economia_reais REAL DEFAULT 0,
    status_fatura TEXT DEFAULT 'PENDENTE',
    enviado_whatsapp_em TEXT DEFAULT NULL,
    pago_em TEXT DEFAULT NULL,
    importacao_id INTEGER DEFAULT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(uc, chave_periodo)
  );
`);

// Migração automática para bancos existentes adicionando colunas por cliente
const colunasClientesAtuais = new Set(
  db.prepare('PRAGMA table_info(clientes)').all().map(c => c.name)
);
const novasColunasClientes = [
  ['tarifa_neoenergia', 'REAL DEFAULT 1.11'],
  ['tarifa_conta_1', 'REAL DEFAULT NULL'],
  ['tarifa_conta_2', 'REAL DEFAULT NULL'],
  ['tarifa_conta_3', 'REAL DEFAULT NULL'],
  ['tarifa_tacticus', 'REAL DEFAULT 0.90'],
  ['base_calculo', "TEXT DEFAULT 'energia_consumida'"],
  ['chave_pix', "TEXT DEFAULT 'contato@renatofeijo.com.br'"],
  ['telefone_contato', "TEXT DEFAULT '(81) 99950-3231'"],
];
for (const [colName, colDef] of novasColunasClientes) {
  if (!colunasClientesAtuais.has(colName)) {
    db.exec(`ALTER TABLE clientes ADD COLUMN ${colName} ${colDef}`);
  }
}

const DEFAULT_CONFIGS = {
  tarifa_neoenergia: '1.11',
  tarifa_tacticus: '0.90',
  bandeira_padrao: 'AMARELA',
  adicional_verde: '0',
  adicional_amarela: '1.885',
  adicional_vermelha: '4.463',
  base_calculo: 'energia_consumida',
  chave_pix: 'contato@renatofeijo.com.br',
  telefone_contato: '(81) 99950-3231',
  gmail_query: 'from:neoenergia.com OR subject:"NEOENERGIA PERNAMBUCO" OR label:Label_26',
  gmail_access_token: '',
  gmail_refresh_token: '',
  gmail_client_id: '',
  gmail_client_secret: '',
  n8n_webhook_gmail_url: '',
  sheets_spreadsheet_id: '1_liYvkIu6gcDbxMec6IC48xWdE_2A7Qxkmdg-MEz5nk',
  sheets_gid: '0',
  evolution_api_url: 'https://evolution.tacticus.com.br',
  evolution_instance: 'Energia_Solar',
  evolution_api_key: 'DA1D022443AA-4163-AF4E-F296F2BDFF86',
  whatsapp_delay_min: '23',
  whatsapp_delay_max: '37',
  whatsapp_caption: 'Sua Conta de Energia Chegou!',
};

export function getConfiguracoes() {
  const rows = db.prepare('SELECT chave, valor FROM configuracoes').all();
  const map = { ...DEFAULT_CONFIGS };
  for (const r of rows) {
    map[r.chave] = r.valor;
  }
  return map;
}

export function salvarConfiguracoes(novasConfigs = {}) {
  const upsert = db.prepare(`
    INSERT INTO configuracoes (chave, valor)
    VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `);
  for (const [k, v] of Object.entries(novasConfigs)) {
    if (v !== undefined && v !== null) {
      upsert.run(k, String(v));
    }
  }
  return getConfiguracoes();
}

export function getClientes() {
  return db
    .prepare('SELECT * FROM clientes ORDER BY prioridade ASC, nome_cliente ASC')
    .all();
}

function toNullableFloat(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(String(val).replace(',', '.'));
  return Number.isFinite(num) && num > 0 ? Number(num.toFixed(4)) : null;
}

/**
 * Resolve as regras de cálculo, tarifas e PIX específicas de um cliente (com fallback para o padrão).
 */
export function obterRegrasCalculoCliente(cli = {}, configs = null) {
  const cfg = configs || getConfiguracoes();
  const c1 = toNullableFloat(cli?.tarifa_conta_1);
  const c2 = toNullableFloat(cli?.tarifa_conta_2);
  const c3 = toNullableFloat(cli?.tarifa_conta_3);
  const contasValidas = [c1, c2, c3].filter(v => v !== null);

  let tarifaNeo = toNullableFloat(cli?.tarifa_neoenergia);
  if (contasValidas.length > 0) {
    const soma = contasValidas.reduce((acc, n) => acc + n, 0);
    tarifaNeo = Number((soma / contasValidas.length).toFixed(4));
  }
  if (!tarifaNeo) {
    tarifaNeo = Number(cfg.tarifa_neoenergia || 1.11);
  }

  const tarifaTac =
    toNullableFloat(cli?.tarifa_tacticus) ??
    toNullableFloat(cli?.tarifa_personalizada) ??
    Number((tarifaNeo * 0.8).toFixed(4));

  const baseCalculo = cli?.base_calculo || cfg.base_calculo || 'energia_consumida';
  const chavePix = String(cli?.chave_pix || cfg.chave_pix || 'contato@renatofeijo.com.br').trim();
  const telefoneContato = String(cli?.telefone_contato || cfg.telefone_contato || '(81) 99950-3231').trim();

  return {
    tarifaNeoenergia: tarifaNeo,
    tarifaTacticus: tarifaTac,
    tarifaConta1: c1,
    tarifaConta2: c2,
    tarifaConta3: c3,
    baseCalculo,
    chavePix,
    telefoneContato,
    adicionalVerde: Number(cfg.adicional_verde || 0),
    adicionalAmarela: Number(cfg.adicional_amarela || 1.885),
    adicionalVermelha: Number(cfg.adicional_vermelha || 4.463),
  };
}

export function salvarCliente(cliente) {
  const uc = formatarUC15(cliente.uc || cliente.cod_cliente);
  const cod = normalizarUC(uc);
  if (!uc) throw new Error('Código da Unidade Consumidora (UC) é obrigatório.');

  const existente = db.prepare('SELECT * FROM clientes WHERE uc = ?').get(uc);
  const cfg = getConfiguracoes();

  const c1 =
    cliente.tarifa_conta_1 !== undefined
      ? toNullableFloat(cliente.tarifa_conta_1)
      : (existente?.tarifa_conta_1 ?? null);
  const c2 =
    cliente.tarifa_conta_2 !== undefined
      ? toNullableFloat(cliente.tarifa_conta_2)
      : (existente?.tarifa_conta_2 ?? null);
  const c3 =
    cliente.tarifa_conta_3 !== undefined
      ? toNullableFloat(cliente.tarifa_conta_3)
      : (existente?.tarifa_conta_3 ?? null);

  const contasValidas = [c1, c2, c3].filter(v => v !== null);
  let tarifaNeo =
    cliente.tarifa_neoenergia !== undefined && cliente.tarifa_neoenergia !== ''
      ? toNullableFloat(cliente.tarifa_neoenergia)
      : null;

  if (contasValidas.length > 0) {
    const soma = contasValidas.reduce((a, b) => a + b, 0);
    tarifaNeo = Number((soma / contasValidas.length).toFixed(4));
  }
  if (!tarifaNeo) {
    tarifaNeo = existente?.tarifa_neoenergia ?? Number(cfg.tarifa_neoenergia || 1.11);
  }

  const tarifaTac =
    toNullableFloat(cliente?.tarifa_tacticus) ??
    toNullableFloat(cliente?.tarifa_personalizada) ??
    Number((tarifaNeo * 0.8).toFixed(4));

  const baseCalculo =
    cliente.base_calculo || existente?.base_calculo || cfg.base_calculo || 'energia_consumida';
  const chavePix = String(
    cliente.chave_pix ?? existente?.chave_pix ?? cfg.chave_pix ?? 'contato@renatofeijo.com.br'
  ).trim();
  const telefoneContato = String(
    cliente.telefone_contato ?? existente?.telefone_contato ?? cfg.telefone_contato ?? '(81) 99950-3231'
  ).trim();

  const stmt = db.prepare(`
    INSERT INTO clientes (
      uc, cod_cliente, conta_contrato, prioridade, nome_cliente,
      whatsapp, localidade, tipo_unidade, medidor_atual, medidor_antigo,
      saldo_credito_acumulado, tarifa_personalizada,
      tarifa_neoenergia, tarifa_conta_1, tarifa_conta_2, tarifa_conta_3,
      tarifa_tacticus, base_calculo, chave_pix, telefone_contato,
      status_envio, ativo, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(uc) DO UPDATE SET
      cod_cliente = excluded.cod_cliente,
      conta_contrato = CASE WHEN excluded.conta_contrato != '' THEN excluded.conta_contrato ELSE clientes.conta_contrato END,
      prioridade = excluded.prioridade,
      nome_cliente = excluded.nome_cliente,
      whatsapp = excluded.whatsapp,
      localidade = excluded.localidade,
      tipo_unidade = excluded.tipo_unidade,
      medidor_atual = CASE WHEN excluded.medidor_atual != '' THEN excluded.medidor_atual ELSE clientes.medidor_atual END,
      medidor_antigo = CASE WHEN excluded.medidor_antigo != '' THEN excluded.medidor_antigo ELSE clientes.medidor_antigo END,
      tarifa_personalizada = excluded.tarifa_personalizada,
      tarifa_neoenergia = excluded.tarifa_neoenergia,
      tarifa_conta_1 = excluded.tarifa_conta_1,
      tarifa_conta_2 = excluded.tarifa_conta_2,
      tarifa_conta_3 = excluded.tarifa_conta_3,
      tarifa_tacticus = excluded.tarifa_tacticus,
      base_calculo = excluded.base_calculo,
      chave_pix = excluded.chave_pix,
      telefone_contato = excluded.telefone_contato,
      status_envio = excluded.status_envio,
      ativo = excluded.ativo,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    uc,
    cod,
    String(cliente.conta_contrato ?? existente?.conta_contrato ?? '').trim(),
    Number(cliente.prioridade ?? existente?.prioridade ?? 0),
    String(cliente.nome_cliente || existente?.nome_cliente || `Cliente UC ${cod}`).trim(),
    String(cliente.whatsapp ?? existente?.whatsapp ?? '').replace(/\D/g, ''),
    String(cliente.localidade ?? existente?.localidade ?? '').trim(),
    String(cliente.tipo_unidade || existente?.tipo_unidade || 'BENEFICIARIA').trim().toUpperCase(),
    String(cliente.medidor_atual ?? existente?.medidor_atual ?? '').trim(),
    String(cliente.medidor_antigo ?? existente?.medidor_antigo ?? '').trim(),
    Number(cliente.saldo_credito_acumulado ?? existente?.saldo_credito_acumulado ?? 0),
    tarifaTac,
    tarifaNeo,
    c1,
    c2,
    c3,
    tarifaTac,
    baseCalculo,
    chavePix,
    telefoneContato,
    String(cliente.status_envio || existente?.status_envio || 'ENVIAR').trim().toUpperCase(),
    cliente.ativo === 0 || cliente.ativo === false ? 0 : 1
  );

  return db.prepare('SELECT * FROM clientes WHERE uc = ?').get(uc);
}

/**
 * Importa o resultado do parser da Neoenergia para o banco de dados sem duplicar registros.
 */
export function registrarImportacaoNeoenergia({
  parsed,
  origem = 'UPLOAD_PDF',
  arquivoNome = '',
  gmailMessageId = '',
  assuntoEmail = '',
  bandeiraVigencia = null,
}) {
  const configs = getConfiguracoes();
  const bandeiraUsada = String(bandeiraVigencia || configs.bandeira_padrao || 'AMARELA').toUpperCase();

  const clientesAtuais = getClientes();
  const mapaClientes = new Map(clientesAtuais.map(c => [c.uc, c]));

  const updateSaldoStmt = db.prepare(`
    UPDATE clientes
    SET saldo_credito_acumulado = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uc = ?
  `);

  for (const s of parsed.saldosPorUnidade || []) {
    const uc15 = formatarUC15(s.uc);
    if (!mapaClientes.has(uc15)) {
      const novo = salvarCliente({
        uc: uc15,
        prioridade: s.prioridade,
        nome_cliente: `Unidade Consumidora ${normalizarUC(uc15)}`,
        localidade: 'Pernambuco',
        tipo_unidade: s.prioridade === 0 ? 'GERADORA' : 'BENEFICIARIA',
        saldo_credito_acumulado: s.saldo_credito,
      });
      mapaClientes.set(uc15, novo);
    }
    updateSaldoStmt.run(Number(s.saldo_credito || 0), uc15);
  }

  const insertImp = db.prepare(`
    INSERT INTO importacoes (
      origem, arquivo_nome, gmail_message_id, assunto_email,
      titular_relatorio, conta_contrato_titular, periodo_descricao,
      total_injetado, total_compensado, saldo_acumulado,
      proximo_saldo_expirar, ciclo_expirar,
      qtd_registros_importados, qtd_registros_atualizados
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `);

  const impResult = insertImp.run(
    origem,
    arquivoNome,
    gmailMessageId,
    assuntoEmail,
    parsed.header?.titular || '',
    parsed.header?.conta_contrato_titular || '',
    parsed.header?.periodo_descricao || '',
    Number(parsed.resumoGeral?.total_injetado || 0),
    Number(parsed.resumoGeral?.total_compensado || 0),
    Number(parsed.resumoGeral?.saldo_acumulado || 0),
    Number(parsed.resumoGeral?.proximo_saldo_expirar || 0),
    parsed.resumoGeral?.ciclo_expirar || ''
  );
  const importacaoId = Number(impResult.lastInsertRowid);

  let inseridos = 0;
  let atualizados = 0;

  const checkExistenteStmt = db.prepare(
    'SELECT id, bandeira, status_fatura FROM historico_consumo WHERE uc = ? AND chave_periodo = ?'
  );

  const upsertHistStmt = db.prepare(`
    INSERT INTO historico_consumo (
      uc, cod_cliente, chave_periodo, periodo, periodo_label,
      energia_consumida, energia_injetada, energia_faturada, kwh_compensado, credito_mes,
      medidor, leitura_de, leitura_ate, injetado_acumulado, saldo_mes_anterior,
      bandeira, valor_neoenergia, valor_tacticus, economia_reais,
      status_fatura, importacao_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(uc, chave_periodo) DO UPDATE SET
      energia_consumida = excluded.energia_consumida,
      energia_injetada = excluded.energia_injetada,
      energia_faturada = excluded.energia_faturada,
      kwh_compensado = excluded.kwh_compensado,
      credito_mes = excluded.credito_mes,
      medidor = CASE WHEN excluded.medidor != '' THEN excluded.medidor ELSE historico_consumo.medidor END,
      leitura_de = COALESCE(excluded.leitura_de, historico_consumo.leitura_de),
      leitura_ate = COALESCE(excluded.leitura_ate, historico_consumo.leitura_ate),
      injetado_acumulado = COALESCE(excluded.injetado_acumulado, historico_consumo.injetado_acumulado),
      saldo_mes_anterior = COALESCE(excluded.saldo_mes_anterior, historico_consumo.saldo_mes_anterior),
      bandeira = excluded.bandeira,
      valor_neoenergia = excluded.valor_neoenergia,
      valor_tacticus = excluded.valor_tacticus,
      economia_reais = excluded.economia_reais,
      importacao_id = excluded.importacao_id,
      updated_at = CURRENT_TIMESTAMP
  `);

  const updateMedidorClienteStmt = db.prepare(`
    UPDATE clientes
    SET medidor_atual = CASE WHEN ? != '' THEN ? ELSE medidor_atual END,
        updated_at = CURRENT_TIMESTAMP
    WHERE uc = ?
  `);

  for (const reg of parsed.registros || []) {
    const uc15 = formatarUC15(reg.uc);
    if (!uc15) continue;

    if (!mapaClientes.has(uc15)) {
      const novoCli = salvarCliente({
        uc: uc15,
        prioridade: 9,
        nome_cliente: `Cliente UC ${normalizarUC(uc15)}`,
        localidade: 'Pernambuco',
      });
      mapaClientes.set(uc15, novoCli);
    }

    const cli = mapaClientes.get(uc15);
    const regrasCli = obterRegrasCalculoCliente(cli, configs);
    const existente = checkExistenteStmt.get(uc15, reg.chave_periodo);
    const bandeiraReg = reg.chave_periodo === parsed.periodoMaisRecente
      ? bandeiraUsada
      : (existente?.bandeira || bandeiraUsada);

    const kwhBase =
      regrasCli.baseCalculo === 'kwh_compensado' || regrasCli.baseCalculo === 'compensado'
        ? Number(reg.kwh_compensado ?? reg.energia_consumida ?? 0)
        : Number(reg.energia_consumida ?? 0);

    const calc = calcularFaturamento({
      consumoKwh: kwhBase,
      bandeira: bandeiraReg,
      periodo: reg.periodo_label || reg.periodo,
      tarifaNeoenergia: regrasCli.tarifaNeoenergia,
      tarifaTacticus: regrasCli.tarifaTacticus,
      adicionalVerde: regrasCli.adicionalVerde,
      adicionalAmarela: regrasCli.adicionalAmarela,
      adicionalVermelha: regrasCli.adicionalVermelha,
    });

    const statusInicial =
      kwhBase <= 0
        ? 'ISENTA'
        : existente?.status_fatura || (cli?.status_envio === 'ENVIADO' && reg.chave_periodo === parsed.periodoMaisRecente ? 'ENVIADA' : 'PENDENTE');

    upsertHistStmt.run(
      uc15,
      normalizarUC(uc15),
      reg.chave_periodo,
      reg.periodo,
      reg.periodo_label,
      Number(reg.energia_consumida || 0),
      Number(reg.energia_injetada || 0),
      Number(reg.energia_faturada || 30),
      Number(reg.kwh_compensado || 0),
      Number(reg.credito_mes || 0),
      reg.medidor || '',
      reg.leitura_de ?? null,
      reg.leitura_ate ?? null,
      reg.injetado_acumulado ?? null,
      reg.saldo_mes_anterior ?? null,
      bandeiraReg,
      calc.valor_neoenergia,
      calc.valor_tacticus,
      calc.economia_reais,
      statusInicial,
      importacaoId
    );

    if (reg.chave_periodo === parsed.periodoMaisRecente && reg.medidor) {
      updateMedidorClienteStmt.run(reg.medidor, reg.medidor, uc15);
    }

    if (existente) {
      atualizados++;
    } else {
      inseridos++;
    }
  }

  db.prepare(`
    UPDATE importacoes
    SET qtd_registros_importados = ?, qtd_registros_atualizados = ?
    WHERE id = ?
  `).run(inseridos, atualizados, importacaoId);

  return {
    importacaoId,
    inseridos,
    atualizados,
    totalRegistros: (parsed.registros || []).length,
    periodos: parsed.periodos,
    periodoMaisRecente: parsed.periodoMaisRecente,
    header: parsed.header,
    resumoGeral: parsed.resumoGeral,
  };
}

/**
 * Recalcula todas as faturas de um período (ou de todos os períodos) usando as tarifas individuais de cada cliente.
 */
export function recalcularPeriodo(chavePeriodo = null, novaBandeira = null) {
  const configs = getConfiguracoes();
  const clientesMap = new Map(getClientes().map(c => [c.uc, c]));
  const rows = chavePeriodo
    ? db.prepare('SELECT * FROM historico_consumo WHERE chave_periodo = ?').all(chavePeriodo)
    : db.prepare('SELECT * FROM historico_consumo').all();

  const updateStmt = db.prepare(`
    UPDATE historico_consumo
    SET bandeira = ?, valor_neoenergia = ?, valor_tacticus = ?, economia_reais = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const r of rows) {
    const cli = clientesMap.get(r.uc);
    const regrasCli = obterRegrasCalculoCliente(cli, configs);
    const bandeira = novaBandeira ? String(novaBandeira).toUpperCase() : r.bandeira;

    const kwhBase =
      regrasCli.baseCalculo === 'kwh_compensado' || regrasCli.baseCalculo === 'compensado'
        ? Number(r.kwh_compensado ?? r.energia_consumida ?? 0)
        : Number(r.energia_consumida ?? 0);

    const calc = calcularFaturamento({
      consumoKwh: kwhBase,
      bandeira,
      periodo: r.periodo_label || r.periodo,
      tarifaNeoenergia: regrasCli.tarifaNeoenergia,
      tarifaTacticus: regrasCli.tarifaTacticus,
      adicionalVerde: regrasCli.adicionalVerde,
      adicionalAmarela: regrasCli.adicionalAmarela,
      adicionalVermelha: regrasCli.adicionalVermelha,
    });

    updateStmt.run(bandeira, calc.valor_neoenergia, calc.valor_tacticus, calc.economia_reais, r.id);
  }

  return rows.length;
}

/**
 * Inicializa o banco com os 7 clientes reais e o relatório Neoenergia Out/2026 se estiver vazio.
 */
export function inicializarDadosSeed() {
  salvarConfiguracoes(getConfiguracoes());

  const countClientes = db.prepare('SELECT COUNT(*) as c FROM clientes').get().c;
  if (countClientes === 0) {
    for (const cli of INITIAL_CLIENTS) {
      salvarCliente(cli);
    }
  } else {
    db.exec(`
      UPDATE clientes
      SET tarifa_tacticus = ROUND(COALESCE(tarifa_neoenergia, 1.11) * 0.80, 4),
          tarifa_personalizada = ROUND(COALESCE(tarifa_neoenergia, 1.11) * 0.80, 4)
      WHERE tarifa_tacticus IS NULL OR ABS(tarifa_tacticus - 0.90) < 0.0001
    `);
  }

  const countHist = db.prepare('SELECT COUNT(*) as c FROM historico_consumo').get().c;
  if (countHist === 0) {
    const parsed = parseResumoNeoenergia(SAMPLE_NEOENERGIA_REPORT_TEXT, getClientes());
    registrarImportacaoNeoenergia({
      parsed,
      origem: 'SEED_INICIAL',
      arquivoNome: 'Resumo_Neoenergia_Protocolo_1831774576.pdf',
      gmailMessageId: '1a18879ce7a0301a',
      assuntoEmail: 'NEOENERGIA PERNAMBUCO | RESPOSTA AO PROTOCOLO 1831774576',
      bandeiraVigencia: 'AMARELA',
    });
  } else {
    recalcularPeriodo(null, null);
  }
}
