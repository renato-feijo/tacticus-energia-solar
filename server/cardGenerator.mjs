import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, '..', 'images', 'logo-base64.txt');

let cachedLogoBase64 = '';
try {
  cachedLogoBase64 = readFileSync(LOGO_PATH, 'utf8').replace(/\s/g, '');
} catch {
  cachedLogoBase64 = '';
}

export const TABELA_BANDEIRAS_PADRAO = {
  VERDE: {
    adicionalPor100kWh: 0,
    cor: '#2ECC71',
    corTexto: '#FFFFFF',
  },
  AMARELA: {
    adicionalPor100kWh: 1.885,
    cor: '#FFCF33',
    corTexto: '#3D3722',
  },
  VERMELHA: {
    adicionalPor100kWh: 4.463,
    cor: '#E53935',
    corTexto: '#FFFFFF',
  },
};

function texto(valor, fallback = '') {
  return valor === null || valor === undefined ? fallback : String(valor).trim();
}

export function escaparXml(valor) {
  return texto(valor)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function numero(valor) {
  if (typeof valor === 'number') return valor;
  const limpo = texto(valor)
    .replace(/R\$\s?/gi, '')
    .replace(/\s/g, '');
  if (!limpo) return NaN;
  if (limpo.includes(',')) {
    return Number(limpo.replace(/\./g, '').replace(',', '.'));
  }
  return Number(limpo);
}

export function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function quantidade(valor) {
  const n = numero(valor);
  if (!Number.isFinite(n)) return texto(valor);
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function limitar(valor, maximo) {
  const s = texto(valor);
  return s.length <= maximo ? s : `${s.slice(0, maximo - 1).trimEnd()}…`;
}

function renderLogoSvg(logoBase64Raw, x = 26, y = 8, width = 295, height = 92) {
  const logo = texto(logoBase64Raw || cachedLogoBase64).replace(/\s/g, '');
  if (!logo) {
    return `
      <g aria-label="Logo TACTICUS">
        <circle cx="${x + 41}" cy="${y + 47}" r="31" fill="#0B6B3A" opacity="0.10"/>
        <path d="M${x + 24} ${y + 50} L${x + 36} ${y + 62} L${x + 59} ${y + 34}" fill="none" stroke="#0B6B3A" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="${x + 86}" y="${y + 57}" class="logo-text">TACTICUS</text>
      </g>`;
  }

  const mimeDetectado = logo.startsWith('iVBOR')
    ? 'image/png'
    : logo.startsWith('/9j/')
      ? 'image/jpeg'
      : logo.startsWith('R0lGOD')
        ? 'image/gif'
        : logo.startsWith('UklGR')
          ? 'image/webp'
          : 'image/png';

  const href = logo.startsWith('data:') ? logo : `data:${mimeDetectado};base64,${logo}`;
  return `<image href="${escaparXml(href)}" xlink:href="${escaparXml(href)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" aria-label="Logo TACTICUS"/>`;
}

/**
 * Calcula os valores financeiros de acordo com a regra de faturamento da Tacticus.
 */
export function calcularFaturamento({
  consumoKwh,
  bandeira = 'AMARELA',
  periodo = '',
  tarifaNeoenergia = 1.11,
  tarifaTacticus = 0.90,
  adicionalVerde = 0,
  adicionalAmarela = 1.885,
  adicionalVermelha = 4.463,
}) {
  const bandeiraNorm = String(bandeira || 'AMARELA').trim().toUpperCase();
  const mapaBandeira = {
    VERDE: { adicionalPor100kWh: Number(adicionalVerde), cor: '#2ECC71', corTexto: '#FFFFFF' },
    AMARELA: { adicionalPor100kWh: Number(adicionalAmarela), cor: '#FFCF33', corTexto: '#3D3722' },
    VERMELHA: { adicionalPor100kWh: Number(adicionalVermelha), cor: '#E53935', corTexto: '#FFFFFF' },
  };
  const cfg = mapaBandeira[bandeiraNorm] || mapaBandeira.AMARELA;
  const consumo = Math.max(0, Number(consumoKwh) || 0);
  const faixas = consumo / 100;
  const adicional = faixas * cfg.adicionalPor100kWh;
  const valorCalculado = consumo * Number(tarifaNeoenergia) + adicional;
  const valorComDesconto = consumo * Number(tarifaTacticus) + adicional;
  const economia = Math.max(0, valorCalculado - valorComDesconto);
  const percentualEconomia = valorCalculado > 0 ? (economia / valorCalculado) * 100 : 0;

  const adicionalTexto = cfg.adicionalPor100kWh.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });

  const observacaoBandeira =
    cfg.adicionalPor100kWh === 0
      ? `Bandeira Tarifária ${bandeiraNorm} no período ${periodo}. A tarifa não sofre nenhum acréscimo neste mês.`
      : `Bandeira Tarifária ${bandeiraNorm} no período ${periodo}. Custo adicional de R$ ${adicionalTexto} a cada 100 kWh consumidos.`;

  return {
    consumo_kwh: Number(consumo.toFixed(2)),
    bandeira: bandeiraNorm,
    cor_bandeira: cfg.cor,
    cor_texto_bandeira: cfg.corTexto,
    adicional_por_100kwh: cfg.adicionalPor100kWh,
    adicional_valor: Number(adicional.toFixed(2)),
    valor_neoenergia: Number(valorCalculado.toFixed(2)),
    valor_tacticus: Number(valorComDesconto.toFixed(2)),
    economia_reais: Number(economia.toFixed(2)),
    percentual_economia: Number(percentualEconomia.toFixed(2)),
    observacao_bandeira: observacaoBandeira,
  };
}

/**
 * Gera o Card SVG 1200x600 idêntico ao Card_Energia_Solar_n8n_v3.js
 */
export function gerarCardSvg(dados) {
  const valorCalculado = numero(dados.Valor_Calculado ?? dados.valor_neoenergia);
  const valorComDesconto = numero(dados.Valor_Com_Desconto ?? dados.valor_tacticus);
  const economia = Math.max(0, valorCalculado - valorComDesconto);
  const percentualEconomia = valorCalculado > 0 ? (economia / valorCalculado) * 100 : 0;
  const percentualFormatado = percentualEconomia.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const periodo = limitar(dados.Periodo ?? dados.periodo, 34);
  const cliente = limitar(dados.Nome_Cliente ?? dados.nome_cliente, 66);
  const localidade = limitar(dados.Localidade ?? dados.localidade, 74);
  const consumo = quantidade(dados.Consumo_kWh ?? dados.consumo_kwh);
  const bandeira = limitar(texto(dados.Bandeira_Tarifaria ?? dados.bandeira, 'AMARELA').toUpperCase(), 20);
  const estiloBandeira = TABELA_BANDEIRAS_PADRAO[bandeira] ?? TABELA_BANDEIRAS_PADRAO.AMARELA;
  const corBandeira = /^#[0-9A-F]{6}$/i.test(texto(dados.Cor_Bandeira ?? dados.cor_bandeira))
    ? texto(dados.Cor_Bandeira ?? dados.cor_bandeira)
    : estiloBandeira.cor;
  const corTextoBandeira = /^#[0-9A-F]{6}$/i.test(texto(dados.Cor_Texto_Bandeira ?? dados.cor_texto_bandeira))
    ? texto(dados.Cor_Texto_Bandeira ?? dados.cor_texto_bandeira)
    : estiloBandeira.corTexto;

  const chavePix = texto(dados.Chave_Pix ?? dados.chave_pix, 'contato@renatofeijo.com.br');
  const telefoneContato = texto(dados.Telefone_Contato ?? dados.telefone_contato, '(81) 99950-3231');

  const observacao = limitar(
    texto(
      dados.Observacao_Bandeira ?? dados.observacao_bandeira,
      `Bandeira Tarifária ${bandeira} no período ${periodo}. Consulte a fatura para verificar o adicional tarifário aplicado.`
    ),
    145
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-labelledby="titulo descricao">
  <title id="titulo">Economia de Energia Solar — ${escaparXml(periodo)}</title>
  <desc id="descricao">Card de pagamento de ${escaparXml(cliente)}, com consumo, valor da concessionária, valor com energia solar e economia.</desc>

  <defs>
    <clipPath id="cardClip"><rect width="1200" height="600" rx="8"/></clipPath>
    <linearGradient id="solarCard" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#087443"/>
      <stop offset="1" stop-color="#0B9A57"/>
    </linearGradient>
    <linearGradient id="economyPanel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#E7F8ED"/>
      <stop offset="1" stop-color="#F4FBF7"/>
    </linearGradient>
    <style>
      text { font-family: Inter, Poppins, Roboto, DejaVu Sans, Arial, sans-serif; }
      .logo-text { fill:#0A4F9D; font-size:31px; font-weight:800; letter-spacing:1.5px; }
      .header-title { fill:#15241C; font-size:28px; font-weight:800; }
      .header-subtitle { fill:#758078; font-size:12px; font-weight:700; letter-spacing:1.8px; }
      .period { fill:#FFFFFF; font-size:16px; font-weight:800; }
      .period-label { fill:#D7F2E2; font-size:10px; font-weight:800; letter-spacing:1.2px; }
      .info-label { fill:#738078; font-size:11px; font-weight:800; letter-spacing:1px; }
      .info-value { fill:#25332B; font-size:16px; font-weight:650; }
      .metric-label { fill:#657269; font-size:12px; font-weight:800; letter-spacing:1px; }
      .metric-value { fill:#18251E; font-size:36px; font-weight:850; }
      .metric-note { fill:#8A948E; font-size:12px; font-weight:600; }
      .solar-label { fill:#CFF2DC; font-size:12px; font-weight:800; letter-spacing:1px; }
      .solar-value { fill:#FFFFFF; font-size:38px; font-weight:850; }
      .economy-label { fill:#31734E; font-size:13px; font-weight:800; letter-spacing:.5px; }
      .economy-value { fill:#087443; font-size:34px; font-weight:850; }
      .note { fill:#59665E; font-size:13px; }
      .footer { fill:#DDF3E6; font-size:13px; font-weight:600; }
      .footer-strong { fill:#FFFFFF; font-size:16px; font-weight:750; }
    </style>
  </defs>

  <g clip-path="url(#cardClip)">
    <rect width="1200" height="600" fill="#F6F9F7"/>

    <!-- Cabeçalho -->
    <rect width="1200" height="104" fill="#FFFFFF"/>
    <rect y="103" width="1200" height="1" fill="#E3EBE6"/>
    ${renderLogoSvg(dados.Logo_Base64)}
    <line x1="326" y1="22" x2="326" y2="82" stroke="#E0E9E3" stroke-width="2"/>
    <text x="354" y="47" class="header-title">Resumo de economia solar</text>
    <text x="354" y="73" class="header-subtitle">DEMONSTRATIVO MENSAL DE CONSUMO</text>
    <rect x="987" y="25" width="165" height="56" rx="18" fill="#087443"/>
    <text x="1069.5" y="45" class="period-label" text-anchor="middle">PERÍODO</text>
    <text x="1069.5" y="69" class="period" text-anchor="middle">${escaparXml(periodo)}</text>

    <!-- Identificação -->
    <rect x="48" y="122" width="540" height="52" rx="16" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="76" cy="148" r="14" fill="#E6F5EC"/>
    <circle cx="76" cy="144" r="4.5" fill="#087443"/>
    <path d="M68 156 C69 149 83 149 84 156" fill="none" stroke="#087443" stroke-width="2.5" stroke-linecap="round"/>
    <text x="100" y="143" class="info-label">CLIENTE</text>
    <text x="100" y="162" class="info-value">${escaparXml(cliente)}</text>

    <rect x="604" y="122" width="548" height="52" rx="16" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="632" cy="148" r="14" fill="#E6F5EC"/>
    <path d="M632 137 C625 137 621 142 621 148 C621 156 632 163 632 163 C632 163 643 156 643 148 C643 142 639 137 632 137 Z" fill="#087443"/>
    <circle cx="632" cy="147" r="3.5" fill="#FFFFFF"/>
    <text x="656" y="143" class="info-label">LOCAL</text>
    <text x="656" y="162" class="info-value">${escaparXml(localidade)}</text>

    <!-- Indicadores -->
    <rect x="48" y="196" width="330" height="148" rx="20" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="80" cy="228" r="16" fill="#E8F6ED"/>
    <path d="M72 232 C77 221 82 221 88 232" fill="none" stroke="#087443" stroke-width="3" stroke-linecap="round"/>
    <text x="108" y="232" class="metric-label">CONSUMO DO MÊS</text>
    <text x="72" y="291" class="metric-value">${escaparXml(consumo)} <tspan font-size="21" font-weight="750">kWh</tspan></text>
    <text x="72" y="320" class="metric-note">Energia consumida no período</text>

    <circle cx="406" cy="270" r="17" fill="#FFFFFF" stroke="#DDE8E1"/>
    <path d="M399 270 H413 M408 265 L414 270 L408 275" fill="none" stroke="#7B8A81" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

    <rect x="434" y="196" width="330" height="148" rx="20" fill="#FFFFFF" stroke="#DCE6EC"/>
    <circle cx="466" cy="228" r="16" fill="#EAF2FA"/>
    <path d="M458 228 H474 M466 220 V236" stroke="#0A4F9D" stroke-width="2.5" stroke-linecap="round"/>
    <text x="494" y="232" class="metric-label">VALOR NEOENERGIA</text>
    <text x="458" y="291" class="metric-value">R$ ${moeda(valorCalculado)}</text>
    <rect x="458" y="308" width="142" height="22" rx="11" fill="${corBandeira}"/>
    <text x="529" y="323" text-anchor="middle" fill="${corTextoBandeira}" font-size="11" font-weight="850">BANDEIRA ${escaparXml(bandeira)}</text>

    <circle cx="792" cy="270" r="17" fill="#FFFFFF" stroke="#DDE8E1"/>
    <path d="M785 270 H799 M794 265 L800 270 L794 275" fill="none" stroke="#7B8A81" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

    <rect x="820" y="196" width="332" height="148" rx="20" fill="url(#solarCard)"/>
    <circle cx="852" cy="228" r="16" fill="#FFFFFF" opacity="0.16"/>
    <circle cx="852" cy="228" r="6" fill="#FFD34E"/>
    <g stroke="#FFD34E" stroke-width="2" stroke-linecap="round">
      <path d="M852 216 V212 M852 244 V240 M840 228 H836 M868 228 H864 M844 220 L841 217 M863 239 L860 236 M860 220 L863 217 M841 239 L844 236"/>
    </g>
    <text x="880" y="232" class="solar-label">VALOR COM ENERGIA SOLAR</text>
    <text x="844" y="291" class="solar-value">R$ ${moeda(valorComDesconto)}</text>
    <text x="844" y="320" fill="#D9F4E4" font-size="12" font-weight="700">VALOR A PAGAR NESTE MÊS</text>

    <!-- Economia -->
    <rect x="48" y="366" width="1104" height="104" rx="22" fill="url(#economyPanel)" stroke="#CDE8D7"/>
    <circle cx="100" cy="418" r="31" fill="#087443"/>
    <path d="M86 420 L96 430 L115 406" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="150" y="405" class="economy-label">SUA ECONOMIA NESTE MÊS</text>
    <text x="150" y="444" class="economy-value">R$ ${moeda(economia)}</text>
    <line x1="850" y1="390" x2="850" y2="446" stroke="#C9E3D3" stroke-width="2"/>
    <text x="890" y="405" class="economy-label">PERCENTUAL ECONOMIZADO</text>
    <text x="890" y="444" fill="#087443" font-size="31" font-weight="850">${percentualFormatado}%</text>

    <!-- Observação -->
    <circle cx="59" cy="503" r="11" fill="#E6EEE9"/>
    <text x="59" y="508" text-anchor="middle" fill="#657269" font-size="14" font-weight="850">i</text>
    <text x="80" y="508" class="note">${escaparXml(observacao)}</text>

    <!-- Rodapé -->
    <rect y="536" width="1200" height="64" fill="#075F39"/>
    <text x="36" y="559" class="footer">PAGAMENTO VIA PIX</text>
    <g transform="translate(36 570)">
      <path d="M7 0 L14 7 L7 14 L0 7 Z M18 0 L25 7 L18 14 L11 7 Z" fill="none" stroke="#FFFFFF" stroke-width="2"/>
    </g>
    <text x="70" y="586" class="footer-strong">${escaparXml(chavePix)}</text>
    <g transform="translate(916 553)">
      <circle cx="15" cy="15" r="14" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
      <path d="M8 8 C9 19 17 23 23 21 L20 17 L16 19 C13 17 11 15 10 12 L12 9 Z" fill="#FFFFFF"/>
    </g>
    <text x="956" y="574" class="footer-strong">${escaparXml(telefoneContato)}</text>
  </g>
</svg>`;
}

/**
 * Gera a Fatura Detalhada com Gráfico de Histórico de Consumo (1200x1360 SVG)
 */
export function gerarFaturaDetalhadaSvg(dados, historico = [], configTarifas = {}) {
  const valorCalculado = numero(dados.Valor_Calculado ?? dados.valor_neoenergia);
  const valorComDesconto = numero(dados.Valor_Com_Desconto ?? dados.valor_tacticus);
  const economia = Math.max(0, valorCalculado - valorComDesconto);
  const percentualEconomia = valorCalculado > 0 ? (economia / valorCalculado) * 100 : 0;
  const percentualFormatado = percentualEconomia.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const periodo = limitar(dados.Periodo ?? dados.periodo, 34);
  const cliente = limitar(dados.Nome_Cliente ?? dados.nome_cliente, 60);
  const localidade = limitar(dados.Localidade ?? dados.localidade, 64);
  const uc = texto(dados.uc || dados.Cod_Cliente, '-');
  const contaContrato = texto(dados.conta_contrato, '-');
  const medidor = texto(dados.medidor || dados.medidor_atual, '-');
  const leituraDe = dados.leitura_de !== null && dados.leitura_de !== undefined ? quantidade(dados.leitura_de) : '-';
  const leituraAte = dados.leitura_ate !== null && dados.leitura_ate !== undefined ? quantidade(dados.leitura_ate) : '-';
  const saldoCreditoUC = quantidade(dados.saldo_credito_acumulado ?? 0);

  const consumo = quantidade(dados.Consumo_kWh ?? dados.consumo_kwh);
  const kwhCompensado = quantidade(dados.kwh_compensado ?? dados.Consumo_kWh ?? dados.consumo_kwh);
  const bandeira = limitar(texto(dados.Bandeira_Tarifaria ?? dados.bandeira, 'AMARELA').toUpperCase(), 20);
  const estiloBandeira = TABELA_BANDEIRAS_PADRAO[bandeira] ?? TABELA_BANDEIRAS_PADRAO.AMARELA;
  const corBandeira = estiloBandeira.cor;
  const corTextoBandeira = estiloBandeira.corTexto;

  const tarifaNeo = moeda(configTarifas.tarifaNeoenergia ?? 1.11);
  const tarifaTac = moeda(configTarifas.tarifaTacticus ?? 0.90);
  const adicionalValor = moeda(dados.adicional_valor ?? 0);
  const chavePix = texto(dados.Chave_Pix ?? dados.chave_pix, 'contato@renatofeijo.com.br');
  const telefoneContato = texto(dados.Telefone_Contato ?? dados.telefone_contato, '(81) 99950-3231');

  // Prepara últimos 12 meses do histórico para o gráfico de barras
  const histRecente = historico.slice(-12);
  const maxConsumo = Math.max(100, ...histRecente.map(h => Number(h.energia_consumida || h.consumo_kwh || 0)));
  const totalConsumoHist = histRecente.reduce((acc, h) => acc + Number(h.energia_consumida || h.consumo_kwh || 0), 0);
  const mediaConsumoHist = histRecente.length > 0 ? totalConsumoHist / histRecente.length : 0;
  const economiaAcumulada = histRecente.reduce((acc, h) => {
    const c = Number(h.kwh_compensado || h.energia_consumida || 0);
    return acc + c * ((configTarifas.tarifaNeoenergia ?? 1.11) - (configTarifas.tarifaTacticus ?? 0.90));
  }, 0);

  // Geometria do gráfico
  const chartX = 95;
  const chartY = 740;
  const chartW = 1020;
  const chartH = 220;
  const barSlotW = histRecente.length > 0 ? chartW / histRecente.length : chartW;
  const barW = Math.min(48, Math.max(22, barSlotW * 0.56));

  let barsSvg = '';
  // Linhas de grade horizontais
  for (let g = 0; g <= 4; g++) {
    const gy = chartY + chartH - (g / 4) * chartH;
    const gVal = Math.round((g / 4) * maxConsumo);
    barsSvg += `
      <line x1="${chartX}" y1="${gy}" x2="${chartX + chartW}" y2="${gy}" stroke="#E3ECE6" stroke-dasharray="${g === 0 ? 'none' : '4 4'}" stroke-width="1.5"/>
      <text x="${chartX - 12}" y="${gy + 4}" text-anchor="end" fill="#6E7D73" font-size="11" font-weight="600">${gVal}</text>
    `;
  }

  // Linha de média
  if (mediaConsumoHist > 0) {
    const mediaY = chartY + chartH - Math.min(1, mediaConsumoHist / maxConsumo) * chartH;
    barsSvg += `
      <line x1="${chartX}" y1="${mediaY}" x2="${chartX + chartW}" y2="${mediaY}" stroke="#F59E0B" stroke-dasharray="6 4" stroke-width="2"/>
      <rect x="${chartX + chartW - 150}" y="${mediaY - 22}" width="146" height="19" rx="6" fill="#FEF3C7"/>
      <text x="${chartX + chartW - 77}" y="${mediaY - 9}" text-anchor="middle" fill="#92400E" font-size="10.5" font-weight="800">MÉDIA: ${quantidade(mediaConsumoHist)} kWh</text>
    `;
  }

  histRecente.forEach((h, idx) => {
    const val = Number(h.energia_consumida ?? h.consumo_kwh ?? 0);
    const ratio = Math.min(1, Math.max(0, val / maxConsumo));
    const bH = Math.max(6, ratio * chartH);
    const bx = chartX + idx * barSlotW + (barSlotW - barW) / 2;
    const by = chartY + chartH - bH;
    const isAtual =
      String(h.periodo).toLowerCase() === String(periodo).toLowerCase() ||
      String(h.periodo_label).toLowerCase() === String(periodo).toLowerCase() ||
      idx === histRecente.length - 1;
    const fillBar = isAtual ? 'url(#solarCard)' : '#86EFAC';
    const textFill = isAtual ? '#087443' : '#3B4A41';
    const labelMes = texto(h.periodo_label || h.periodo);

    barsSvg += `
      <g>
        <rect x="${bx}" y="${by}" width="${barW}" height="${bH}" rx="6" fill="${fillBar}" stroke="${isAtual ? '#065F36' : '#4ADE80'}" stroke-width="1"/>
        <text x="${bx + barW / 2}" y="${by - 8}" text-anchor="middle" fill="${textFill}" font-size="11.5" font-weight="800">${quantidade(val)}</text>
        <text x="${bx + barW / 2}" y="${chartY + chartH + 20}" text-anchor="middle" fill="${textFill}" font-size="11.5" font-weight="${isAtual ? '800' : '600'}">${escaparXml(labelMes)}</text>
      </g>
    `;
  });

  // Tabela dos últimos 6 meses na parte inferior
  const ultimos6 = histRecente.slice(-6).reverse();
  let rowsTabelaSvg = '';
  ultimos6.forEach((item, idx) => {
    const ry = 1094 + idx * 32;
    const cVal = Number(item.energia_consumida ?? 0);
    const compVal = Number(item.kwh_compensado ?? cVal);
    const calcItem = calcularFaturamento({
      consumoKwh: compVal > 0 ? compVal : cVal,
      bandeira: item.bandeira || bandeira,
      periodo: item.periodo_label || item.periodo,
      ...configTarifas,
    });
    const bgRow = idx % 2 === 0 ? '#F8FBF9' : '#FFFFFF';
    rowsTabelaSvg += `
      <rect x="64" y="${ry - 20}" width="1072" height="30" rx="4" fill="${bgRow}"/>
      <text x="84" y="${ry}" fill="#1E2D24" font-size="12.5" font-weight="700">${escaparXml(item.periodo_label || item.periodo)}</text>
      <text x="270" y="${ry}" fill="#35453B" font-size="12.5" font-weight="600">${quantidade(cVal)} kWh</text>
      <text x="460" y="${ry}" fill="#35453B" font-size="12.5" font-weight="600">${quantidade(compVal)} kWh</text>
      <text x="660" y="${ry}" fill="#4A5A50" font-size="12.5" font-weight="600">R$ ${moeda(calcItem.valor_neoenergia)}</text>
      <text x="860" y="${ry}" fill="#087443" font-size="12.5" font-weight="800">R$ ${moeda(calcItem.valor_tacticus)}</text>
      <text x="1050" y="${ry}" fill="#0B6B3A" font-size="12.5" font-weight="800">R$ ${moeda(calcItem.economia_reais)}</text>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1360" viewBox="0 0 1200 1360" role="img" aria-labelledby="tituloFatura descFatura">
  <title id="tituloFatura">Demonstrativo e Histórico de Energia Solar — ${escaparXml(cliente)} (${escaparXml(periodo)})</title>
  <desc id="descFatura">Fatura detalhada de energia solar com leitura de medidor, comparativo tarifário e gráfico de histórico de consumo.</desc>

  <defs>
    <clipPath id="faturaClip"><rect width="1200" height="1360" rx="10"/></clipPath>
    <linearGradient id="solarCard" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#087443"/>
      <stop offset="1" stop-color="#0B9A57"/>
    </linearGradient>
    <linearGradient id="economyPanel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#E7F8ED"/>
      <stop offset="1" stop-color="#F4FBF7"/>
    </linearGradient>
    <style>
      text { font-family: Inter, Poppins, Roboto, DejaVu Sans, Arial, sans-serif; }
      .logo-text { fill:#0A4F9D; font-size:31px; font-weight:800; letter-spacing:1.5px; }
      .header-title { fill:#15241C; font-size:26px; font-weight:800; }
      .header-subtitle { fill:#647369; font-size:12px; font-weight:700; letter-spacing:1.6px; }
      .info-label { fill:#6E7D73; font-size:10.5px; font-weight:800; letter-spacing:0.9px; }
      .info-value { fill:#1B2A21; font-size:15px; font-weight:750; }
      .metric-label { fill:#657269; font-size:12px; font-weight:800; letter-spacing:1px; }
      .metric-value { fill:#18251E; font-size:34px; font-weight:850; }
      .section-title { fill:#15241C; font-size:16px; font-weight:800; letter-spacing:0.5px; }
      .footer { fill:#DDF3E6; font-size:13px; font-weight:600; }
      .footer-strong { fill:#FFFFFF; font-size:16px; font-weight:750; }
    </style>
  </defs>

  <g clip-path="url(#faturaClip)">
    <rect width="1200" height="1360" fill="#F4F8F5"/>

    <!-- Cabeçalho -->
    <rect width="1200" height="106" fill="#FFFFFF"/>
    <rect y="105" width="1200" height="1" fill="#DCE7E0"/>
    ${renderLogoSvg(dados.Logo_Base64)}
    <line x1="326" y1="22" x2="326" y2="84" stroke="#E0E9E3" stroke-width="2"/>
    <text x="352" y="46" class="header-title">Demonstrativo de Faturamento e Histórico Solar</text>
    <text x="352" y="72" class="header-subtitle">RELATÓRIO DE GERAÇÃO DISTRIBUÍDA • NEOENERGIA / TACTICUS</text>
    <rect x="975" y="22" width="177" height="60" rx="16" fill="#087443"/>
    <text x="1063.5" y="43" fill="#D7F2E2" font-size="10px" font-weight="800" letter-spacing="1.2px" text-anchor="middle">MÊS DE REFERÊNCIA</text>
    <text x="1063.5" y="68" fill="#FFFFFF" font-size="18px" font-weight="850" text-anchor="middle">${escaparXml(periodo)}</text>

    <!-- Bloco de Dados Cadastrais e Medição -->
    <rect x="48" y="124" width="1104" height="114" rx="18" fill="#FFFFFF" stroke="#DCE7E0"/>
    <text x="72" y="148" class="info-label">TITULAR / BENEFICIÁRIO</text>
    <text x="72" y="170" class="info-value">${escaparXml(cliente)}</text>

    <text x="490" y="148" class="info-label">LOCALIDADE</text>
    <text x="490" y="170" class="info-value">${escaparXml(localidade)}</text>

    <text x="890" y="148" class="info-label">UNIDADE CONSUMIDORA (UC)</text>
    <text x="890" y="170" class="info-value">${escaparXml(uc)}</text>

    <line x1="72" y1="184" x2="1128" y2="184" stroke="#EBF1ED" stroke-width="1.5"/>

    <text x="72" y="204" class="info-label">CONTA CONTRATO</text>
    <text x="72" y="224" class="info-value">${escaparXml(contaContrato)}</text>

    <text x="290" y="204" class="info-label">MEDIDOR</text>
    <text x="290" y="224" class="info-value">${escaparXml(medidor)}</text>

    <text x="490" y="204" class="info-label">LEITURA ANTERIOR → ATUAL</text>
    <text x="490" y="224" class="info-value">${escaparXml(leituraDe)} → ${escaparXml(leituraAte)}</text>

    <text x="750" y="204" class="info-label">KWH COMPENSADO</text>
    <text x="750" y="224" class="info-value">${escaparXml(kwhCompensado)} kWh</text>

    <text x="945" y="204" class="info-label">SALDO CRÉDITO UC</text>
    <text x="945" y="224" class="info-value" fill="#087443">${escaparXml(saldoCreditoUC)} kWh</text>

    <!-- Três Cards Principais de Valor -->
    <rect x="48" y="256" width="348" height="148" rx="20" fill="#FFFFFF" stroke="#DCE7E0"/>
    <text x="76" y="288" class="metric-label">CONSUMO APURADO NO MÊS</text>
    <text x="76" y="342" class="metric-value">${escaparXml(consumo)} <tspan font-size="20" font-weight="750">kWh</tspan></text>
    <text x="76" y="374" fill="#647369" font-size="12.5" font-weight="600">Tarifa Solar Tacticus: R$ ${tarifaTac}/kWh</text>

    <rect x="426" y="256" width="348" height="148" rx="20" fill="#FFFFFF" stroke="#DCE6EC"/>
    <text x="454" y="288" class="metric-label">SEM ENERGIA SOLAR (NEOENERGIA)</text>
    <text x="454" y="342" class="metric-value">R$ ${moeda(valorCalculado)}</text>
    <rect x="454" y="358" width="144" height="24" rx="12" fill="${corBandeira}"/>
    <text x="526" y="374" text-anchor="middle" fill="${corTextoBandeira}" font-size="11" font-weight="850">BANDEIRA ${escaparXml(bandeira)}</text>
    <text x="612" y="374" fill="#647369" font-size="11.5" font-weight="600">Tarifa: R$ ${tarifaNeo}/kWh</text>

    <rect x="804" y="256" width="348" height="148" rx="20" fill="url(#solarCard)"/>
    <text x="832" y="288" fill="#CFF2DC" font-size="12px" font-weight="800" letter-spacing="1px">TOTAL A PAGAR (ENERGIA SOLAR)</text>
    <text x="832" y="344" fill="#FFFFFF" font-size="38px" font-weight="850">R$ ${moeda(valorComDesconto)}</text>
    <text x="832" y="374" fill="#D9F4E4" font-size="12px" font-weight="700">Adicional Bandeira incluso: R$ ${adicionalValor}</text>

    <!-- Painel de Economia Mensal + Acumulada -->
    <rect x="48" y="422" width="1104" height="96" rx="20" fill="url(#economyPanel)" stroke="#CDE8D7"/>
    <circle cx="96" cy="470" r="28" fill="#087443"/>
    <path d="M84 472 L93 481 L110 459" fill="none" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="142" y="456" fill="#31734E" font-size="12px" font-weight="800" letter-spacing="0.6px">SUA ECONOMIA NESTE MÊS</text>
    <text x="142" y="492" fill="#087443" font-size="32px" font-weight="850">R$ ${moeda(economia)} <tspan font-size="18" font-weight="750">(${percentualFormatado}%)</tspan></text>

    <line x1="610" y1="440" x2="610" y2="500" stroke="#C5E2D0" stroke-width="2"/>
    <text x="646" y="456" fill="#31734E" font-size="12px" font-weight="800" letter-spacing="0.6px">ECONOMIA ACUMULada (${histRecente.length} MESES)</text>
    <text x="646" y="492" fill="#087443" font-size="30px" font-weight="850">R$ ${moeda(economiaAcumulada)}</text>

    <!-- Gráfico de Histórico de Consumo (12 Meses) -->
    <rect x="48" y="536" width="1104" height="456" rx="20" fill="#FFFFFF" stroke="#DCE7E0"/>
    <text x="76" y="572" class="section-title">HISTÓRICO DE CONSUMO MENSAL (kWh)</text>
    <text x="76" y="592" fill="#68776D" font-size="12.5" font-weight="600">Evolução do consumo da Unidade Consumidora nos últimos períodos apurados pela Neoenergia</text>

    <rect x="890" y="554" width="234" height="36" rx="10" fill="#F2F8F4" stroke="#D9E8DF"/>
    <text x="1007" y="577" text-anchor="middle" fill="#087443" font-size="12.5" font-weight="800">Total 12m: ${quantidade(totalConsumoHist)} kWh</text>

    ${barsSvg}

    <!-- Tabela Resumo dos Últimos 6 Meses -->
    <rect x="48" y="1008" width="1104" height="270" rx="20" fill="#FFFFFF" stroke="#DCE7E0"/>
    <text x="76" y="1040" class="section-title">DETALHAMENTO DOS ÚLTIMOS 6 CICLOS DE FATURAMENTO</text>
    <rect x="64" y="1052" width="1072" height="24" rx="4" fill="#E9F3EC"/>
    <text x="84" y="1068" fill="#2E4236" font-size="11" font-weight="800">PERÍODO</text>
    <text x="270" y="1068" fill="#2E4236" font-size="11" font-weight="800">CONSUMO REDE</text>
    <text x="460" y="1068" fill="#2E4236" font-size="11" font-weight="800">KWH COMPENSADO</text>
    <text x="660" y="1068" fill="#2E4236" font-size="11" font-weight="800">VALOR NEOENERGIA</text>
    <text x="860" y="1068" fill="#2E4236" font-size="11" font-weight="800">VALOR SOLAR</text>
    <text x="1050" y="1068" fill="#2E4236" font-size="11" font-weight="800">ECONOMIA</text>
    ${rowsTabelaSvg}

    <!-- Rodapé -->
    <rect y="1296" width="1200" height="64" fill="#075F39"/>
    <text x="36" y="1319" class="footer">PAGAMENTO VIA PIX</text>
    <g transform="translate(36 1330)">
      <path d="M7 0 L14 7 L7 14 L0 7 Z M18 0 L25 7 L18 14 L11 7 Z" fill="none" stroke="#FFFFFF" stroke-width="2"/>
    </g>
    <text x="70" y="1346" class="footer-strong">${escaparXml(chavePix)}</text>
    <g transform="translate(916 1313)">
      <circle cx="15" cy="15" r="14" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
      <path d="M8 8 C9 19 17 23 23 21 L20 17 L16 19 C13 17 11 15 10 12 L12 9 Z" fill="#FFFFFF"/>
    </g>
    <text x="956" y="1334" class="footer-strong">${escaparXml(telefoneContato)}</text>
  </g>
</svg>`;
}

/**
 * Converte uma string SVG para PNG ou PDF usando ImageMagick (`magick` / `convert`) ou `rsvg-convert`.
 */
export function converterSvgBuffer(svgString, formato = 'png') {
  const ext = formato === 'pdf' ? 'pdf' : 'png';
  const id = randomUUID();
  const tmpSvg = join(tmpdir(), `card-${id}.svg`);
  const tmpOut = join(tmpdir(), `card-${id}.${ext}`);
  try {
    writeFileSync(tmpSvg, svgString, 'utf8');
    try {
      execFileSync('magick', ['-density', '144', tmpSvg, tmpOut], {
        maxBuffer: 25 * 1024 * 1024,
      });
    } catch {
      try {
        execFileSync('rsvg-convert', ['-f', ext, '-o', tmpOut, tmpSvg], {
          maxBuffer: 25 * 1024 * 1024,
        });
      } catch {
        execFileSync('convert', ['-density', '144', tmpSvg, tmpOut], {
          maxBuffer: 25 * 1024 * 1024,
        });
      }
    }
    return readFileSync(tmpOut);
  } finally {
    try { unlinkSync(tmpSvg); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

