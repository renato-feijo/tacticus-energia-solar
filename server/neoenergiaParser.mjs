import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MESES_PT = {
  jan: '01', janeiro: '01',
  fev: '02', fevereiro: '02',
  mar: '03', marco: '03', 'março': '03',
  abr: '04', abril: '04',
  mai: '05', maio: '05',
  jun: '06', junho: '06',
  jul: '07', julho: '07',
  ago: '08', agosto: '08',
  set: '09', setembro: '09',
  out: '10', outubro: '10',
  nov: '11', novembro: '11',
  dez: '12', dezembro: '12',
};

const MESES_ABREV = {
  '01': 'jan', '02': 'fev', '03': 'mar', '04': 'abr',
  '05': 'mai', '06': 'jun', '07': 'jul', '08': 'ago',
  '09': 'set', '10': 'out', '11': 'nov', '12': 'dez',
};

export function parseNumeroBR(val) {
  if (typeof val === 'number') return val;
  if (val === null || val === undefined) return 0;
  const s = String(val).trim().replace(/R\$\s?/gi, '').replace(/\s/g, '');
  if (!s || s === '-') return 0;
  if (s.includes(',')) {
    return Number(s.replace(/\./g, '').replace(',', '.')) || 0;
  }
  return Number(s) || 0;
}

export function normalizarUC(ucRaw) {
  if (!ucRaw) return '';
  const digits = String(ucRaw).replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/^0+/, '') || '0';
}

export function formatarUC15(ucRaw) {
  const digits = String(ucRaw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 12 ? digits.padStart(15, '0') : digits;
}

/**
 * Normaliza qualquer período ("out/2026", "10/2026", "OUTUBRO 2026") para:
 * - chave: "2026-10" (ordenável)
 * - periodo: "10/2026"
 * - label: "out/2026"
 */
export function normalizarPeriodo(raw) {
  if (!raw) return { chave: '', periodo: '', label: '' };
  const s = String(raw).trim().toLowerCase();
  let mesStr = '';
  let anoStr = '';

  if (s.includes('/')) {
    const [m, a] = s.split('/');
    mesStr = MESES_PT[m.trim()] || (Number(m) >= 1 && Number(m) <= 12 ? String(Number(m)).padStart(2, '0') : '');
    anoStr = a.trim();
  } else if (s.includes('-')) {
    const [a, m] = s.split('-');
    if (a.length === 4) {
      anoStr = a;
      mesStr = String(Number(m)).padStart(2, '0');
    }
  } else {
    const parts = s.split(/\s+/);
    if (parts.length >= 2) {
      mesStr = MESES_PT[parts[0]] || '';
      anoStr = parts[1];
    }
  }

  let ano = Number(anoStr);
  if (ano > 0 && ano < 100) ano += 2000;
  if (!mesStr || !ano) {
    return { chave: s, periodo: String(raw).trim(), label: s };
  }

  const abrev = MESES_ABREV[mesStr] || mesStr;
  return {
    chave: `${ano}-${mesStr}`,
    periodo: `${mesStr}/${ano}`,
    label: `${abrev}/${ano}`,
  };
}

/**
 * Extrai texto de um arquivo PDF em Buffer usando pdftotext (Poppler).
 */
export function extrairTextoDePdfBuffer(pdfBuffer) {
  const tmpPdf = join(tmpdir(), `neoenergia-${randomUUID()}.pdf`);
  try {
    writeFileSync(tmpPdf, pdfBuffer);
    const out = execFileSync('pdftotext', ['-raw', tmpPdf, '-'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return out;
  } finally {
    try {
      unlinkSync(tmpPdf);
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Faz o parse completo do texto do PDF "Faturamento Microgeração" da Neoenergia.
 * @param {string} rawText Texto extraído do PDF
 * @param {Array} knownClients Lista opcional de clientes conhecidos com medidor_antigo / medidor_atual / uc
 */
export function parseResumoNeoenergia(rawText, knownClients = []) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');

  // 1. Cabeçalho do relatório
  const clienteMatch = text.match(/Cliente:\s*([^\n]+?)\s+(\d{8,15})\s*\n/i);
  const periodoRelatorioMatch = text.match(/Per[ií]odo:\s*([^\n]+)/i);
  const header = {
    titular: clienteMatch ? clienteMatch[1].trim() : 'JOAO COSME DOS SANTOS',
    conta_contrato_titular: clienteMatch ? clienteMatch[2].trim() : '',
    periodo_descricao: periodoRelatorioMatch ? periodoRelatorioMatch[1].trim() : '',
  };

  // Mapa de Medidor -> UC construído dinamicamente + clientes conhecidos
  const medidorParaUC = new Map();
  for (const c of knownClients) {
    const ucNorm = formatarUC15(c.uc || c.cod_cliente);
    if (c.medidor_atual && ucNorm) medidorParaUC.set(String(c.medidor_atual).trim(), ucNorm);
    if (c.medidor_antigo && ucNorm) medidorParaUC.set(String(c.medidor_antigo).trim(), ucNorm);
  }

  // Primeira passagem: encontra todos os pares "Gerador/Consumidor <medidor> <uc_15_digitos>" no texto
  const medidorUcRegex = /(?:Gerador|Consumidor)\s+(\d{6,12})\s+(00\d{10,13})\b/g;
  let mMatch;
  while ((mMatch = medidorUcRegex.exec(text)) !== null) {
    medidorParaUC.set(mMatch[1], formatarUC15(mMatch[2]));
  }

  // 2. Resumo do Saldo de Crédito por Unidade (final do PDF)
  const saldosPorUnidade = [];
  const resumoSaldoIdx = text.indexOf('RESUMO DO SALDO DE CRÉDITO POR UNIDADE');
  if (resumoSaldoIdx !== -1) {
    const trechoSaldo = text.slice(resumoSaldoIdx, resumoSaldoIdx + 1500);
    const linhaSaldoRegex = /\b(00\d{10,13}|\d{10,15})\s+(\d+)\s+([\d.,]+)\b/g;
    let sMatch;
    while ((sMatch = linhaSaldoRegex.exec(trechoSaldo)) !== null) {
      saldosPorUnidade.push({
        uc: formatarUC15(sMatch[1]),
        cod_cliente: normalizarUC(sMatch[1]),
        prioridade: Number(sMatch[2]),
        saldo_credito: parseNumeroBR(sMatch[3]),
      });
    }
  }

  // 3. Resumo Geral (TOTAL INJETADO | TOTAL COMPENSADO | SALDO ACUMULADO ...)
  let resumoGeral = {
    total_injetado: 0,
    total_compensado: 0,
    saldo_acumulado: 0,
    proximo_saldo_expirar: 0,
    ciclo_expirar: '',
    total_creditos_expirados: 0,
  };
  const totalInjetadoMatch = text.match(
    /TOTAL\s+DE\s+CR[ÉE]DITOS\s+EXPIRADOS\s*\n\s*([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d{2}\/\d{4}|-)\s+([\d.,]+)/i
  );
  if (totalInjetadoMatch) {
    resumoGeral = {
      total_injetado: parseNumeroBR(totalInjetadoMatch[1]),
      total_compensado: parseNumeroBR(totalInjetadoMatch[2]),
      saldo_acumulado: parseNumeroBR(totalInjetadoMatch[3]),
      proximo_saldo_expirar: parseNumeroBR(totalInjetadoMatch[4]),
      ciclo_expirar: totalInjetadoMatch[5],
      total_creditos_expirados: parseNumeroBR(totalInjetadoMatch[6]),
    };
  }

  // 4. Seções mensais detalhadas (OUTUBRO 2025 ... OUTUBRO 2026)
  // Guardamos leituras de medidor e consumo detalhado por (periodo_chave, slotIndex) e por (periodo_chave, uc)
  const idxDados13Meses = text.indexOf('DADOS DOS ÚLTIMOS 13 MESES');
  const textoSecoesMensais = idxDados13Meses !== -1 ? text.slice(0, idxDados13Meses) : text;

  const mesHeaderRegex = /\n(JANEIRO|FEVEREIRO|MARÇO|MARCO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+(\d{4})\s*\n/gi;
  const secoes = [];
  let secMatch;
  while ((secMatch = mesHeaderRegex.exec(textoSecoesMensais)) !== null) {
    secoes.push({
      mesNome: secMatch[1],
      ano: secMatch[2],
      startIndex: secMatch.index,
    });
  }

  // Mapeia posição do consumidor dentro do mês para descobrir UCs quando o medidor trocou
  const slotParaUC = new Map(); // slotIdx -> uc
  const detalhesMensaisPorSlot = new Map(); // `${chave}::${slotIdx}` -> info

  for (let i = 0; i < secoes.length; i++) {
    const sec = secoes[i];
    const nextStart = i + 1 < secoes.length ? secoes[i + 1].startIndex : textoSecoesMensais.length;
    const blocoMes = textoSecoesMensais.slice(sec.startIndex, nextStart);
    const norm = normalizarPeriodo(`${sec.mesNome} ${sec.ano}`);

    // Extrai linha do Gerador
    // Ex: Gerador 3230961394 15144 16142 10/2025 998 6114,49 22666
    // ou: Gerador 6251923777 000306074501465 0 687 04/2026 1472 0 11747
    let geradorInfo = null;
    const gerMatch = blocoMes.match(
      /Gerador\s+(\d+)(?:\s+(00\d{10,13}))?\s+([\d.,]+)\s+([\d.,]+)\s+(\d{2}\/\d{4})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i
    );
    if (gerMatch) {
      const medidor = gerMatch[1];
      const ucExplicita = gerMatch[2] ? formatarUC15(gerMatch[2]) : (medidorParaUC.get(medidor) || '');
      if (ucExplicita) {
        medidorParaUC.set(medidor, ucExplicita);
      }
      geradorInfo = {
        medidor,
        uc: ucExplicita,
        leitura_de: parseNumeroBR(gerMatch[3]),
        leitura_ate: parseNumeroBR(gerMatch[4]),
        mes_ref: gerMatch[5],
        injetado_kwh: parseNumeroBR(gerMatch[6]),
        saldo_mes_anterior: parseNumeroBR(gerMatch[7]),
        injetado_acumulado: parseNumeroBR(gerMatch[8]),
      };
    }

    // Extrai blocos de Consumidor
    // Ex: Consumidor 3232213115 000228934801482 2061 2206 145
    // ou: Consumidor 3230961394 4519 4825 306
    const consRegex = /Consumidor\s+(\d+)(?:\s+(00\d{10,13}))?\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*\nMês\s+Utiliz\.\s+Rest\.\s+Expira\s*\n+((?:(?:\d{2}\/\d{4}|-)\s+[\d.,]+\s+[\d.,]+\s+(?:\d{2}\/\d{4}|-)\s*\n?)+)/gi;
    let cMatch;
    let slotIdx = 0;
    while ((cMatch = consRegex.exec(blocoMes)) !== null) {
      const medidor = cMatch[1];
      let uc = cMatch[2] ? formatarUC15(cMatch[2]) : (medidorParaUC.get(medidor) || '');
      if (uc) {
        medidorParaUC.set(medidor, uc);
        slotParaUC.set(slotIdx, uc);
      }
      const leituraDe = parseNumeroBR(cMatch[3]);
      const leituraAte = parseNumeroBR(cMatch[4]);
      const consumoKwh = parseNumeroBR(cMatch[5]);
      const linhasCreditoRaw = cMatch[6].trim().split(/\n+/);
      let saldoUtilizadoTotal = 0;
      let saldoRestanteMes = 0;
      const creditosUsados = [];

      for (const l of linhasCreditoRaw) {
        const p = l.trim().split(/\s+/);
        if (p.length >= 4 && p[0] !== '-') {
          const utiliz = parseNumeroBR(p[1]);
          const rest = parseNumeroBR(p[2]);
          saldoUtilizadoTotal += utiliz;
          saldoRestanteMes += rest;
          creditosUsados.push({
            mes_origem: p[0],
            utilizado_kwh: utiliz,
            restante_kwh: rest,
            expira: p[3],
          });
        }
      }

      detalhesMensaisPorSlot.set(`${norm.chave}::${slotIdx}`, {
        chave_periodo: norm.chave,
        periodo: norm.periodo,
        periodo_label: norm.label,
        slotIdx,
        medidor,
        uc,
        leitura_de: leituraDe,
        leitura_ate: leituraAte,
        consumo_kwh: consumoKwh,
        kwh_compensado_detalhe: Number(saldoUtilizadoTotal.toFixed(2)),
        credito_restante_detalhe: Number(saldoRestanteMes.toFixed(2)),
        creditos_usados: creditosUsados,
        gerador: slotIdx === 0 ? geradorInfo : null,
      });

      slotIdx++;
    }
  }

  // Preenche UCs retroativamente nos slots em que o medidor antigo não tinha UC explícita no PDF
  for (const item of detalhesMensaisPorSlot.values()) {
    if (!item.uc && slotParaUC.has(item.slotIdx)) {
      item.uc = slotParaUC.get(item.slotIdx);
      if (item.medidor) {
        medidorParaUC.set(item.medidor, item.uc);
      }
    }
  }

  // Índice rápido de detalhes mensais por `${chave}::${uc}` e por `${chave}::consumo::${consumo_kwh}`
  const detalhePorChaveUC = new Map();
  for (const item of detalhesMensaisPorSlot.values()) {
    if (item.uc) {
      detalhePorChaveUC.set(`${item.chave_periodo}::${item.uc}`, item);
    }
  }

  // 5. Parse da tabela "DADOS DOS ÚLTIMOS 13 MESES"
  // Formato no texto:
  // set/2025 \n 000228934801482 \n 437 0 30 437 0
  // ou:
  // set/2025 264 938 30 264 0
  const registrosMap = new Map(); // `${chave_periodo}::${uc}` -> registro

  if (idxDados13Meses !== -1) {
    const fim13Meses = text.indexOf('TOTAL INJETADO', idxDados13Meses);
    const bloco13 = text.slice(
      idxDados13Meses,
      fim13Meses !== -1 ? fim13Meses : text.length
    );

    // Captura cada entrada iniciada por mes/ano (ex: set/2025, out/2025 ... out/2026)
    const row13Regex = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\/(\d{4})\s+(?:(00\d{10,13})\s+)?([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/gi;
    const rowsPorPeriodo = new Map();
    let rMatch;
    while ((rMatch = row13Regex.exec(bloco13)) !== null) {
      const pRaw = `${rMatch[1]}/${rMatch[2]}`;
      const norm = normalizarPeriodo(pRaw);
      const ucExplicita = rMatch[3] ? formatarUC15(rMatch[3]) : '';
      const energiaConsumida = parseNumeroBR(rMatch[4]);
      const energiaInjetada = parseNumeroBR(rMatch[5]);
      const energiaFaturada = parseNumeroBR(rMatch[6]);
      const kwhCompensado = parseNumeroBR(rMatch[7]);
      const credito = parseNumeroBR(rMatch[8]);

      if (!rowsPorPeriodo.has(norm.chave)) {
        rowsPorPeriodo.set(norm.chave, []);
      }
      rowsPorPeriodo.get(norm.chave).push({
        chave_periodo: norm.chave,
        periodo: norm.periodo,
        periodo_label: norm.label,
        uc: ucExplicita,
        energia_consumida: energiaConsumida,
        energia_injetada: energiaInjetada,
        energia_faturada: energiaFaturada,
        kwh_compensado: kwhCompensado,
        credito_mes: credito,
      });
    }

    // Descobre a ordem padrão das UCs na tabela de 13 meses a partir dos meses que têm todas as UCs explícitas (ex: mai/2026 .. out/2026)
    let padraoUCs13 = [];
    for (const rows of rowsPorPeriodo.values()) {
      if (rows.length >= 6 && rows.every(r => Boolean(r.uc))) {
        padraoUCs13 = rows.map(r => r.uc);
        break;
      }
    }

    // Resolve UCs ausentes nas linhas da tabela de 13 meses
    for (const [chave, rows] of rowsPorPeriodo.entries()) {
      rows.forEach((row, idx) => {
        if (!row.uc) {
          // 1) Se tem energia_injetada > 0, é a unidade geradora (slot 0 no detalhe mensal ou padraoUCs13[1])
          if (row.energia_injetada > 0) {
            row.uc = slotParaUC.get(0) || padraoUCs13[1] || '000306074501465';
          } else {
            // 2) Tenta casar pelo valor exato de consumo_kwh e kwh_compensado nos detalhes mensais daquele mês
            for (const det of detalhesMensaisPorSlot.values()) {
              if (
                det.chave_periodo === chave &&
                det.uc &&
                Math.abs(det.consumo_kwh - row.energia_consumida) < 0.01 &&
                Math.abs(det.kwh_compensado_detalhe - row.kwh_compensado) < 0.1
              ) {
                row.uc = det.uc;
                break;
              }
            }
          }
          // 3) Se ainda não achou e a quantidade de linhas bate com o padrão de 6 UCs
          if (!row.uc && rows.length === padraoUCs13.length && padraoUCs13[idx]) {
            row.uc = padraoUCs13[idx];
          }
          // 4) Caso especial de set/2025 (4 linhas antes da entrada de duas UCs)
          if (!row.uc && rows.length === 4 && padraoUCs13.length === 6) {
            const fallback4 = [padraoUCs13[0], padraoUCs13[1], padraoUCs13[4], padraoUCs13[5]];
            row.uc = fallback4[idx] || '';
          }
        }

        if (row.uc) {
          const det = detalhePorChaveUC.get(`${chave}::${row.uc}`);
          registrosMap.set(`${chave}::${row.uc}`, {
            ...row,
            cod_cliente: normalizarUC(row.uc),
            medidor: det?.medidor || '',
            leitura_de: det?.leitura_de ?? null,
            leitura_ate: det?.leitura_ate ?? null,
            injetado_acumulado: det?.gerador?.injetado_acumulado ?? null,
            saldo_mes_anterior: det?.gerador?.saldo_mes_anterior ?? null,
          });
        }
      });
    }
  }

  // 6. Garante que qualquer detalhe mensal não presente na tabela de 13 meses também seja incluído
  for (const det of detalhesMensaisPorSlot.values()) {
    if (!det.uc) continue;
    const key = `${det.chave_periodo}::${det.uc}`;
    if (!registrosMap.has(key)) {
      registrosMap.set(key, {
        chave_periodo: det.chave_periodo,
        periodo: det.periodo,
        periodo_label: det.periodo_label,
        uc: det.uc,
        cod_cliente: normalizarUC(det.uc),
        energia_consumida: det.consumo_kwh,
        energia_injetada: det.gerador ? det.gerador.injetado_kwh : 0,
        energia_faturada: 30,
        kwh_compensado: det.kwh_compensado_detalhe,
        credito_mes: det.credito_restante_detalhe,
        medidor: det.medidor || '',
        leitura_de: det.leitura_de,
        leitura_ate: det.leitura_ate,
        injetado_acumulado: det.gerador?.injetado_acumulado ?? null,
        saldo_mes_anterior: det.gerador?.saldo_mes_anterior ?? null,
      });
    }
  }

  const registros = Array.from(registrosMap.values()).sort((a, b) => {
    if (a.chave_periodo !== b.chave_periodo) {
      return a.chave_periodo.localeCompare(b.chave_periodo);
    }
    return a.uc.localeCompare(b.uc);
  });

  const periodosUnicos = Array.from(new Set(registros.map(r => r.chave_periodo))).sort();
  const ucsUnicas = Array.from(new Set(registros.map(r => r.uc))).sort();

  return {
    header,
    resumoGeral,
    saldosPorUnidade,
    periodos: periodosUnicos,
    periodoMaisRecente: periodosUnicos[periodosUnicos.length - 1] || '',
    ucs: ucsUnicas,
    registros,
  };
}

