/**
 * n8n — node Code
 * Mode: Run Once for All Items
 *
 * Entrada esperada em cada item:
 * - Periodo
 * - Nome_Cliente
 * - Localidade
 * - Consumo_kWh
 * - Valor_Calculado
 * - Valor_Com_Desconto
 *
 * Campos opcionais:
 * - Bandeira_Tarifaria       (VERDE | AMARELA | VERMELHA — padrão: AMARELA)
 * - Cor_Bandeira             (padrão automático conforme bandeira)
 * - Cor_Texto_Bandeira       (padrão automático conforme bandeira)
 * - Observacao_Bandeira      (texto completo da observação)
 * - Logo_Base64              (Base64 puro ou data URI)
 * - Logo_Mime                (padrão: image/png)
 *
 * Saída:
 * - json com os valores calculados e formatados
 * - binary.card contendo card-pagamento.svg
 */

const items = $input.all();

function texto(valor, fallback = '') {
  return valor === null || valor === undefined ? fallback : String(valor).trim();
}

function escapar(valor) {
  return texto(valor)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function numero(valor) {
  if (typeof valor === 'number') return valor;

  const limpo = texto(valor)
    .replace(/R\$\s?/gi, '')
    .replace(/\s/g, '');

  if (!limpo) return NaN;

  // Formato brasileiro: 1.234,56
  if (limpo.includes(',')) {
    return Number(limpo.replace(/\./g, '').replace(',', '.'));
  }

  return Number(limpo);
}

function moeda(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function quantidade(valor) {
  const n = numero(valor);
  if (!Number.isFinite(n)) return texto(valor);
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function limitar(valor, maximo) {
  const s = texto(valor);
  return s.length <= maximo ? s : `${s.slice(0, maximo - 1).trimEnd()}…`;
}

function logoSvg(dados) {
  const logo = texto(dados.Logo_Base64).replace(/\s/g, '');

  if (!logo) {
    return `
      <g aria-label="Logo TACTICUS">
        <circle cx="67" cy="55" r="31" fill="#0B6B3A" opacity="0.10"/>
        <path d="M50 58 L62 70 L85 42" fill="none" stroke="#0B6B3A" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="112" y="65" class="logo-text">TACTICUS</text>
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
          : texto(dados.Logo_Mime, 'image/png');

  const href = logo.startsWith('data:')
    ? logo
    : `data:${mimeDetectado};base64,${logo}`;

  return `<image href="${escapar(href)}" xlink:href="${escapar(href)}" x="26" y="8" width="295" height="92" preserveAspectRatio="xMidYMid meet" aria-label="Logo TACTICUS"/>`;
}

const coresPadraoBandeira = {
  VERDE: { fundo: '#2ECC71', texto: '#FFFFFF' },
  AMARELA: { fundo: '#FFCF33', texto: '#3D3722' },
  VERMELHA: { fundo: '#E53935', texto: '#FFFFFF' },
};

return items.map((item, index) => {
  const dados = item.json ?? {};
  const valorCalculado = numero(dados.Valor_Calculado);
  const valorComDesconto = numero(dados.Valor_Com_Desconto);

  if (!Number.isFinite(valorCalculado) || !Number.isFinite(valorComDesconto)) {
    throw new Error(`Item ${index}: Valor_Calculado e Valor_Com_Desconto devem ser números válidos.`);
  }

  const economia = Math.max(0, valorCalculado - valorComDesconto);
  const percentualEconomia = valorCalculado > 0 ? (economia / valorCalculado) * 100 : 0;
  const percentualFormatado = percentualEconomia.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const periodo = limitar(dados.Periodo, 34);
  const cliente = limitar(dados.Nome_Cliente, 66);
  const localidade = limitar(dados.Localidade, 74);
  const consumo = quantidade(dados.Consumo_kWh);
  const bandeira = limitar(texto(dados.Bandeira_Tarifaria, 'AMARELA').toUpperCase(), 20);
  const estiloBandeira = coresPadraoBandeira[bandeira] ?? coresPadraoBandeira.AMARELA;
  const corBandeira = /^#[0-9A-F]{6}$/i.test(texto(dados.Cor_Bandeira))
    ? texto(dados.Cor_Bandeira)
    : estiloBandeira.fundo;
  const corTextoBandeira = /^#[0-9A-F]{6}$/i.test(texto(dados.Cor_Texto_Bandeira))
    ? texto(dados.Cor_Texto_Bandeira)
    : estiloBandeira.texto;
  const observacao = limitar(
    texto(
      dados.Observacao_Bandeira,
      `Bandeira Tarifária ${bandeira} no período ${periodo}. Consulte a fatura para verificar o adicional tarifário aplicado.`,
    ),
    145,
  );

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-labelledby="titulo descricao">
  <title id="titulo">Economia de Energia Solar — ${escapar(periodo)}</title>
  <desc id="descricao">Card de pagamento de ${escapar(cliente)}, com consumo, valor da concessionária, valor com energia solar e economia.</desc>

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
      text { font-family: Inter, Poppins, Roboto, Arial, sans-serif; }
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
    ${logoSvg(dados)}
    <line x1="326" y1="22" x2="326" y2="82" stroke="#E0E9E3" stroke-width="2"/>
    <text x="354" y="47" class="header-title">Resumo de economia solar</text>
    <text x="354" y="73" class="header-subtitle">DEMONSTRATIVO MENSAL DE CONSUMO</text>
    <rect x="987" y="25" width="165" height="56" rx="18" fill="#087443"/>
    <text x="1069.5" y="45" class="period-label" text-anchor="middle">PERÍODO</text>
    <text x="1069.5" y="69" class="period" text-anchor="middle">${escapar(periodo)}</text>

    <!-- Identificação -->
    <rect x="48" y="122" width="540" height="52" rx="16" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="76" cy="148" r="14" fill="#E6F5EC"/>
    <circle cx="76" cy="144" r="4.5" fill="#087443"/>
    <path d="M68 156 C69 149 83 149 84 156" fill="none" stroke="#087443" stroke-width="2.5" stroke-linecap="round"/>
    <text x="100" y="143" class="info-label">CLIENTE</text>
    <text x="100" y="162" class="info-value">${escapar(cliente)}</text>

    <rect x="604" y="122" width="548" height="52" rx="16" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="632" cy="148" r="14" fill="#E6F5EC"/>
    <path d="M632 137 C625 137 621 142 621 148 C621 156 632 163 632 163 C632 163 643 156 643 148 C643 142 639 137 632 137 Z" fill="#087443"/>
    <circle cx="632" cy="147" r="3.5" fill="#FFFFFF"/>
    <text x="656" y="143" class="info-label">LOCAL</text>
    <text x="656" y="162" class="info-value">${escapar(localidade)}</text>

    <!-- Indicadores -->
    <rect x="48" y="196" width="330" height="148" rx="20" fill="#FFFFFF" stroke="#E0E8E3"/>
    <circle cx="80" cy="228" r="16" fill="#E8F6ED"/>
    <path d="M72 232 C77 221 82 221 88 232" fill="none" stroke="#087443" stroke-width="3" stroke-linecap="round"/>
    <text x="108" y="232" class="metric-label">CONSUMO DO MÊS</text>
    <text x="72" y="291" class="metric-value">${escapar(consumo)} <tspan font-size="21" font-weight="750">kWh</tspan></text>
    <text x="72" y="320" class="metric-note">Energia consumida no período</text>

    <circle cx="406" cy="270" r="17" fill="#FFFFFF" stroke="#DDE8E1"/>
    <path d="M399 270 H413 M408 265 L414 270 L408 275" fill="none" stroke="#7B8A81" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

    <rect x="434" y="196" width="330" height="148" rx="20" fill="#FFFFFF" stroke="#DCE6EC"/>
    <circle cx="466" cy="228" r="16" fill="#EAF2FA"/>
    <path d="M458 228 H474 M466 220 V236" stroke="#0A4F9D" stroke-width="2.5" stroke-linecap="round"/>
    <text x="494" y="232" class="metric-label">VALOR NEOENERGIA</text>
    <text x="458" y="291" class="metric-value">R$ ${moeda(valorCalculado)}</text>
    <rect x="458" y="308" width="142" height="22" rx="11" fill="${corBandeira}"/>
    <text x="529" y="323" text-anchor="middle" fill="${corTextoBandeira}" font-size="11" font-weight="850">BANDEIRA ${escapar(bandeira)}</text>

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
    <text x="80" y="508" class="note">${escapar(observacao)}</text>

    <!-- Rodapé -->
    <rect y="536" width="1200" height="64" fill="#075F39"/>
    <text x="36" y="559" class="footer">PAGAMENTO VIA PIX</text>
    <g transform="translate(36 570)">
      <path d="M7 0 L14 7 L7 14 L0 7 Z M18 0 L25 7 L18 14 L11 7 Z" fill="none" stroke="#FFFFFF" stroke-width="2"/>
    </g>
    <text x="70" y="586" class="footer-strong">contato@renatofeijo.com.br</text>
    <g transform="translate(916 553)">
      <circle cx="15" cy="15" r="14" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
      <path d="M8 8 C9 19 17 23 23 21 L20 17 L16 19 C13 17 11 15 10 12 L12 9 Z" fill="#FFFFFF"/>
    </g>
    <text x="956" y="574" class="footer-strong">(81) 99950-3231</text>
  </g>
</svg>`;

  return {
    json: {
      ...dados,
      Valor_Calculado_Formatado: moeda(valorCalculado),
      Valor_Com_Desconto_Formatado: moeda(valorComDesconto),
      Economia: economia,
      Economia_Formatada: moeda(economia),
      Percentual_Economia: percentualEconomia,
      Percentual_Economia_Formatado: percentualFormatado,
    },
    binary: {
      card: {
        data: Buffer.from(svg, 'utf8').toString('base64'),
        mimeType: 'image/svg+xml',
        fileName: `card-energia-${index + 1}.svg`,
        fileExtension: 'svg',
      },
    },
  };
});
