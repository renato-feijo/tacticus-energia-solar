// ─── FALLBACKS MODERN WEB GUIDANCE (light-dismiss-a-dialog & validate-input-after-interaction) ─
function setupDialogFallbacks() {
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    });
  }
}

const UserInvalidFallback = (() => {
  const dirtyState = new WeakMap();
  const updateState = input => {
    if (!input.checkValidity) return;
    const isValid = input.checkValidity();
    input.classList.toggle('user-invalid-fallback', !isValid);
    input.classList.toggle('user-valid-fallback', isValid);
    if (!isValid) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  };
  const handleEvent = event => {
    const input = event.target;
    if (event.type === 'reset') {
      const controls = input.elements || [];
      for (const control of controls) {
        dirtyState.delete(control);
        control.classList.remove('user-invalid-fallback', 'user-valid-fallback');
        control.removeAttribute('aria-invalid');
      }
      return;
    }
    if (!input.checkValidity) return;
    if (event.type === 'input' || event.type === 'change') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyState.set(input, state);
      if (state.hasBlurred) updateState(input);
    } else if (event.type === 'blur') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(input, state);
      if (state.hasInteracted) updateState(input);
    }
  };
  const init = (root = document) => {
    if (!CSS.supports('selector(:user-invalid)')) {
      root.addEventListener('blur', handleEvent, true);
      root.addEventListener('input', handleEvent);
      root.addEventListener('change', handleEvent);
      root.addEventListener('reset', handleEvent, true);
    }
    const syncAria = el => {
      if (el && typeof el.matches === 'function' && el.tagName === 'INPUT') {
        try {
          el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
        } catch {}
      }
    };
    root.addEventListener('blur', e => syncAria(e.target), true);
    root.addEventListener('input', e => {
      if (e.target?.hasAttribute?.('aria-invalid')) syncAria(e.target);
    });
  };
  return { init };
})();

// ─── ESTADO DA APLICAÇÃO ───────────────────────────────────────────────────
const state = {
  overview: null,
  clientes: [],
  historicoCompleto: [],
  periodoSelecionado: '',
  previewAtual: {
    uc: '',
    chavePeriodo: '',
    modo: 'card',
  },
  filaWhatsAppCancelada: false,
  filaWhatsAppRodando: false,
};

// ─── UTILITÁRIOS DE FORMATAÇÃO ─────────────────────────────────────────────
function fmtMoeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtKwh(v) {
  if (v === null || v === undefined || v === '') return '-';
  return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `Erro HTTP ${resp.status}`);
  }
  return data;
}

// ─── NAVEGAÇÃO ENTRE ABAS ──────────────────────────────────────────────────
function ativarAba(nomeAba) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === nomeAba);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const ativo = panel.id === `tab-${nomeAba}`;
    panel.classList.toggle('active', ativo);
    panel.hidden = !ativo;
  });
  if (nomeAba === 'historico') {
    carregarHistoricoCompleto();
  } else if (nomeAba === 'clientes') {
    carregarClientes();
  }
}

// ─── CARREGAMENTO PRINCIPAL (DASHBOARD & FATURAMENTO) ──────────────────────
async function carregarOverview(chavePeriodo = null) {
  const query = chavePeriodo ? `?chave_periodo=${encodeURIComponent(chavePeriodo)}` : '';
  const data = await apiFetch(`/api/overview${query}`);
  state.overview = data;
  state.periodoSelecionado = data.chaveSelecionada;

  renderSeletorPeriodos(data.periodos, data.chaveSelecionada);
  renderKPIs(data);
  renderGraficoEvolucaoGeral(data.evolucaoMensal);
  renderSaldosUsina(data);
  renderTabelaFaturasMes(data.faturasPeriodo, data.chaveSelecionada);
  renderTabelaImportacoes(data.importacoesRecentes || []);
  preencherFormularioConfiguracoes(data.configuracoes || {});
  preencherFiltroClientesHistorico(data.faturasPeriodo || []);
}

function renderSeletorPeriodos(periodos, selecionado) {
  const select = document.getElementById('selectPeriodoGlobal');
  select.innerHTML = periodos
    .map(
      p =>
        `<option value="${esc(p.chave_periodo)}" ${
          p.chave_periodo === selecionado ? 'selected' : ''
        }>${esc(p.periodo_label.toUpperCase())} (${esc(p.periodo)})</option>`
    )
    .join('');

  const pAtual = periodos.find(p => p.chave_periodo === selecionado);
  if (pAtual) {
    document.getElementById('tituloCicloAtual').textContent = `${pAtual.periodo_label.toUpperCase()} — Bandeira ${pAtual.bandeira}`;
    const selBand = document.getElementById('selectBandeiraGlobal');
    if (pAtual.bandeira) selBand.value = pAtual.bandeira;
  }
}

function renderKPIs(data) {
  const faturas = data.faturasPeriodo || [];
  const consumoMes = faturas.reduce((s, r) => s + Number(r.energia_consumida || 0), 0);
  const injetadoMes = faturas.reduce((s, r) => s + Number(r.energia_injetada || 0), 0);
  const faturamentoSolarMes = faturas.reduce((s, r) => s + Number(r.valor_tacticus || 0), 0);
  const valorNeoenergiaMes = faturas.reduce((s, r) => s + Number(r.valor_neoenergia || 0), 0);
  const economiaMes = faturas.reduce((s, r) => s + Number(r.economia_reais || 0), 0);
  const saldoTotalCreditos = faturas.reduce((s, r) => s + Number(r.saldo_credito_acumulado || 0), 0);

  const grid = document.getElementById('kpiGridDashboard');
  grid.innerHTML = `
    <div class="kpi-card highlight">
      <span class="kpi-label">Faturamento Solar no Ciclo</span>
      <div class="kpi-value">R$ ${fmtMoeda(faturamentoSolarMes)}</div>
      <span class="kpi-sub">Neoenergia seria R$ ${fmtMoeda(valorNeoenergiaMes)}</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Economia Gerada no Mês</span>
      <div class="kpi-value" style="color: var(--solar-primary)">R$ ${fmtMoeda(economiaMes)}</div>
      <span class="kpi-sub">Acumulado 14m: R$ ${fmtMoeda(data.totaisHistorico?.economia_clientes_acumulada)}</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Energia Injetada vs. Consumida</span>
      <div class="kpi-value">${fmtKwh(injetadoMes)} / ${fmtKwh(consumoMes)} <small style="font-size:0.95rem">kWh</small></div>
      <span class="kpi-sub">Geração da Usina vs. Consumo das UCs no ciclo</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Saldo Acumulado de Créditos</span>
      <div class="kpi-value">${fmtKwh(data.ultimaImportacao?.saldo_acumulado || saldoTotalCreditos)} <small style="font-size:0.95rem">kWh</small></div>
      <span class="kpi-sub">Próx. a expirar: ${fmtKwh(data.ultimaImportacao?.proximo_saldo_expirar)} kWh (${esc(data.ultimaImportacao?.ciclo_expirar || '-')})</span>
    </div>
  `;
}

function renderGraficoEvolucaoGeral(evolucao = []) {
  const container = document.getElementById('chartEvolucaoGeral');
  if (!evolucao.length) {
    container.innerHTML = '<p class="muted-state">Sem dados históricos disponíveis.</p>';
    return;
  }

  const width = 760;
  const height = 250;
  const padX = 48;
  const padY = 28;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2 - 14;

  const maxVal = Math.max(
    500,
    ...evolucao.map(e => Math.max(Number(e.total_injetado || 0), Number(e.total_consumido || 0)))
  );

  const slotW = chartW / evolucao.length;
  const barW = Math.min(20, Math.max(10, slotW * 0.34));

  let svgContent = '';
  for (let i = 0; i <= 4; i++) {
    const y = padY + chartH - (i / 4) * chartH;
    const val = Math.round((i / 4) * maxVal);
    svgContent += `
      <line x1="${padX}" y1="${y}" x2="${padX + chartW}" y2="${y}" stroke="#e4ede7" stroke-dasharray="${i === 0 ? 'none' : '4 4'}"/>
      <text x="${padX - 8}" y="${y + 4}" text-anchor="end" fill="#68776e" font-size="10.5" font-weight="600">${val}</text>
    `;
  }

  evolucao.forEach((item, idx) => {
    const inj = Number(item.total_injetado || 0);
    const cons = Number(item.total_consumido || 0);
    const hInj = Math.max(3, (inj / maxVal) * chartH);
    const hCons = Math.max(3, (cons / maxVal) * chartH);

    const center = padX + idx * slotW + slotW / 2;
    const xInj = center - barW - 2;
    const xCons = center + 2;
    const yInj = padY + chartH - hInj;
    const yCons = padY + chartH - hCons;
    const isSel = item.chave_periodo === state.periodoSelecionado;

    svgContent += `
      <g style="cursor:pointer" data-periodo="${esc(item.chave_periodo)}" class="chart-bar-group">
        <rect x="${xInj}" y="${yInj}" width="${barW}" height="${hInj}" rx="4" fill="#087443" opacity="${isSel ? '1' : '0.82'}">
          <title>${esc(item.periodo_label)} • Injetado: ${fmtKwh(inj)} kWh</title>
        </rect>
        <rect x="${xCons}" y="${yCons}" width="${barW}" height="${hCons}" rx="4" fill="#3b82f6" opacity="${isSel ? '1' : '0.82'}">
          <title>${esc(item.periodo_label)} • Consumido: ${fmtKwh(cons)} kWh</title>
        </rect>
        <text x="${center}" y="${padY + chartH + 18}" text-anchor="middle" fill="${isSel ? '#087443' : '#4a5a50'}" font-size="10.5" font-weight="${isSel ? '800' : '600'}">${esc(item.periodo_label)}</text>
      </g>
    `;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="250" role="img" aria-label="Gráfico de evolução mensal de energia injetada e consumida">
      ${svgContent}
    </svg>
  `;

  container.querySelectorAll('.chart-bar-group').forEach(g => {
    g.addEventListener('click', () => {
      carregarOverview(g.dataset.periodo);
    });
  });
}

function renderSaldosUsina(data) {
  const imp = data.ultimaImportacao || {};
  document.getElementById('usinaTitularLabel').textContent = imp.titular_relatorio
    ? `${imp.titular_relatorio} • CC ${imp.conta_contrato_titular}`
    : 'Resumo Microgeração Neoenergia';

  const box = document.getElementById('usinaSaldosBox');
  const clientesComSaldo = (data.faturasPeriodo || []).filter(c => Number(c.saldo_credito_acumulado) > 0);

  box.innerHTML = `
    <div class="saldo-stat-row">
      <span>Total Injetado (13 meses)</span>
      <strong>${fmtKwh(imp.total_injetado)} kWh</strong>
    </div>
    <div class="saldo-stat-row">
      <span>Total Compensado (13 meses)</span>
      <strong>${fmtKwh(imp.total_compensado)} kWh</strong>
    </div>
    <div class="saldo-stat-row">
      <span>Saldo Acumulado Disponível</span>
      <strong>${fmtKwh(imp.saldo_acumulado)} kWh</strong>
    </div>
    <div class="saldo-stat-row">
      <span>Próximo Saldo a Expirar (${esc(imp.ciclo_expirar || '-')})</span>
      <strong style="color: var(--warning)">${fmtKwh(imp.proximo_saldo_expirar)} kWh</strong>
    </div>
    <div style="margin-top: 0.35rem; font-size: 0.78rem; font-weight: 700; color: var(--text-secondary);">
      DISTRIBUIÇÃO DO SALDO POR UC:
    </div>
    ${clientesComSaldo
      .map(
        c => `
      <div class="saldo-stat-row" style="padding: 0.45rem 0.75rem; font-size: 0.82rem;">
        <span>${esc(c.nome_cliente.split(' ').slice(0, 2).join(' '))} (${esc(c.cod_cliente)})</span>
        <strong>${fmtKwh(c.saldo_credito_acumulado)} kWh</strong>
      </div>
    `
      )
      .join('')}
  `;
}

function renderTabelaFaturasMes(faturas, chavePeriodo) {
  const tbody = document.getElementById('tbodyFaturasMes');
  if (!faturas.length) {
    tbody.innerHTML = '<tr><td colspan="9">Nenhum cliente cadastrado.</td></tr>';
    return;
  }

  tbody.innerHTML = faturas
    .map(f => {
      const temRegistro = Boolean(f.historico_id);
      const consumo = temRegistro ? Number(f.energia_consumida || 0) : null;
      const compensado = temRegistro ? Number(f.kwh_compensado || 0) : null;
      const statusFatura = f.status_fatura || 'SEM_LEITURA';
      const badgeClass =
        statusFatura === 'PAGA'
          ? 'badge-paga'
          : statusFatura === 'ENVIADA'
            ? 'badge-enviada'
            : statusFatura === 'ISENTA'
              ? 'badge-isenta'
              : 'badge-pendente';

      return `
        <tr>
          <th scope="row">
            <div>${esc(f.nome_cliente)}</div>
            <div style="font-size: 0.76rem; color: var(--text-secondary); font-weight: 500;">
              📍 ${esc(f.localidade || '-')} • Prioridade ${esc(f.prioridade)}
            </div>
          </th>
          <td>
            <div style="font-weight: 700; font-family: monospace;">${esc(f.uc)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">
              Medidor: ${esc(f.medidor || f.medidor_atual || '-')}
            </div>
          </td>
          <td>
            ${
              f.leitura_de !== null && f.leitura_de !== undefined
                ? `<span style="font-family:monospace;font-weight:600">${fmtKwh(f.leitura_de)} → ${fmtKwh(f.leitura_ate)}</span>`
                : '<span style="color:var(--text-muted)">Sem leitura no ciclo</span>'
            }
          </td>
          <td>
            ${
              temRegistro
                ? `<strong>${fmtKwh(consumo)} kWh</strong>
                   <div style="font-size:0.74rem;color:var(--text-secondary)">Compensado: ${fmtKwh(compensado)} kWh</div>`
                : '-'
            }
          </td>
          <td>
            ${
              temRegistro
                ? `<div>R$ ${fmtMoeda(f.valor_neoenergia)}</div>
                   <div style="font-size:0.72rem;color:var(--text-secondary)">Tarifa: R$ ${Number(f.tarifa_neoenergia_efetiva || f.tarifa_neoenergia || 1.11).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 4 })}/kWh</div>`
                : `<div style="font-size:0.74rem;color:var(--text-secondary)">R$ ${Number(f.tarifa_neoenergia_efetiva || 1.11).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 4 })}/kWh</div>`
            }
          </td>
          <td>
            ${
              temRegistro
                ? `<strong style="color:var(--solar-primary);font-size:0.96rem">R$ ${fmtMoeda(f.valor_tacticus)}</strong>
                   <div style="font-size:0.72rem;color:var(--text-secondary)">Solar: R$ ${Number(f.tarifa_tacticus_efetiva || f.tarifa_tacticus || 0.72).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/kWh</div>`
                : `<div style="font-size:0.74rem;color:var(--text-secondary)">R$ ${Number(f.tarifa_tacticus_efetiva || 0.72).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/kWh</div>`
            }
          </td>
          <td>
            ${
              temRegistro
                ? `<span style="color:#0b6b3a;font-weight:700">R$ ${fmtMoeda(f.economia_reais)}</span>`
                : '-'
            }
          </td>
          <td>
            <span class="badge ${badgeClass}">${esc(statusFatura)}</span>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem">
              Fila: <strong>${esc(f.status_envio)}</strong>
            </div>
          </td>
          <td>
            <div class="action-btn-group">
              ${
                temRegistro
                  ? `<button type="button" class="btn btn-primary btn-sm btn-preview" data-uc="${esc(f.uc)}" data-periodo="${esc(chavePeriodo)}" data-modo="card">
                      🖼️ Card
                    </button>
                    <button type="button" class="btn btn-secondary btn-sm btn-preview" data-uc="${esc(f.uc)}" data-periodo="${esc(chavePeriodo)}" data-modo="detalhada">
                      📄 Fatura + Histórico
                    </button>
                    <button type="button" class="btn btn-success btn-sm btn-whats-single" data-uc="${esc(f.uc)}" data-periodo="${esc(chavePeriodo)}" data-nome="${esc(f.nome_cliente)}">
                      📲 WhatsApp
                    </button>
                    <button type="button" class="btn btn-secondary btn-sm btn-marcar-paga" data-id="${f.historico_id}" data-status="${statusFatura === 'PAGA' ? 'PENDENTE' : 'PAGA'}" title="Alternar Paga / Pendente">
                      ${statusFatura === 'PAGA' ? '↩️' : '✅'}
                    </button>`
                  : `<span style="font-size:0.76rem;color:var(--text-muted)">Sem leitura no mês</span>`
              }
              <button type="button" class="btn btn-secondary btn-sm btn-config-cliente" data-uc="${esc(f.uc)}" title="Configurar Tarifas (Média 3 Contas) & PIX deste cliente">
                💰 Tarifas & PIX
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-preview').forEach(btn => {
    btn.addEventListener('click', () => {
      abrirPreviewModal(btn.dataset.uc, btn.dataset.periodo, btn.dataset.modo);
    });
  });

  tbody.querySelectorAll('.btn-config-cliente').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!state.clientes.length) {
        const data = await apiFetch('/api/clientes');
        state.clientes = data.clientes || [];
      }
      const cli =
        state.clientes.find(x => x.uc === btn.dataset.uc) ||
        (state.overview?.faturasPeriodo || []).find(x => x.uc === btn.dataset.uc);
      if (cli) abrirModalCliente(cli);
    });
  });

  tbody.querySelectorAll('.btn-whats-single').forEach(btn => {
    btn.addEventListener('click', () => {
      enviarWhatsAppIndividual(btn.dataset.uc, btn.dataset.periodo, 'card', btn.dataset.nome);
    });
  });

  tbody.querySelectorAll('.btn-marcar-paga').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch('/api/historico/atualizar', {
          method: 'POST',
          body: JSON.stringify({
            id: Number(btn.dataset.id),
            status_fatura: btn.dataset.status,
          }),
        });
        showToast(`Status atualizado para ${btn.dataset.status}!`);
        carregarOverview(state.periodoSelecionado);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ─── MODAL DE PREVIEW DO CARD (1200x600) E FATURA DETALHADA (1200x1360) ────
async function abrirPreviewModal(uc, chavePeriodo, modo = 'card') {
  state.previewAtual = { uc, chavePeriodo, modo };
  const dialog = document.getElementById('dialogPreviewFatura');
  await atualizarConteudoPreviewModal();
  if (!dialog.open) {
    dialog.showModal();
  }
}

async function atualizarConteudoPreviewModal() {
  const { uc, chavePeriodo, modo } = state.previewAtual;
  document.getElementById('btnModoCard').classList.toggle('active', modo === 'card');
  document.getElementById('btnModoDetalhada').classList.toggle('active', modo === 'detalhada');

  const wrapper = document.getElementById('previewSvgWrapper');
  wrapper.innerHTML = '<p style="padding:2rem;text-align:center;font-weight:700;">Gerando visualização...</p>';

  const baseParams = `uc=${encodeURIComponent(uc)}&chave_periodo=${encodeURIComponent(chavePeriodo)}&tipo=${encodeURIComponent(modo)}`;
  const svgResp = await fetch(`/api/fatura/preview?${baseParams}&formato=svg`);
  const svgText = await svgResp.text();
  wrapper.innerHTML = svgText;

  document.getElementById('linkDownloadPng').href = `/api/fatura/preview?${baseParams}&formato=png&download=1`;
  document.getElementById('linkDownloadPdf').href = `/api/fatura/preview?${baseParams}&formato=pdf&download=1`;
  document.getElementById('linkDownloadSvg').href = `/api/fatura/preview?${baseParams}&formato=svg&download=1`;
}

// ─── ENVIO WHATSAPP INDIVIDUAL E EM LOTE (COM DELAY 23–37s) ────────────────
async function enviarWhatsAppIndividual(uc, chavePeriodo, tipo = 'card', nomeCliente = '') {
  try {
    showToast(`Enviando ${tipo === 'detalhada' ? 'Fatura' : 'Card'} de ${nomeCliente || uc} via WhatsApp...`);
    const res = await apiFetch('/api/whatsapp/enviar', {
      method: 'POST',
      body: JSON.stringify({ uc, chave_periodo: chavePeriodo, tipo, formato: 'png' }),
    });
    showToast(`Enviado com sucesso para ${res.cliente} (${res.whatsapp})!`);
    await carregarOverview(state.periodoSelecionado);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function dispararFilaWhatsAppLote() {
  if (state.filaWhatsAppRodando) return;
  const faturas = (state.overview?.faturasPeriodo || []).filter(
    f => f.historico_id && f.status_envio === 'ENVIAR' && Number(f.energia_consumida) > 0
  );

  if (faturas.length === 0) {
    showToast('Nenhum cliente com Status = ENVIAR e consumo positivo neste período.', 'error');
    return;
  }

  state.filaWhatsAppRodando = true;
  state.filaWhatsAppCancelada = false;
  const banner = document.getElementById('batchQueueBanner');
  const statusEl = document.getElementById('batchQueueStatusText');
  const detailEl = document.getElementById('batchQueueDetailText');
  banner.hidden = false;

  for (let i = 0; i < faturas.length; i++) {
    if (state.filaWhatsAppCancelada) break;
    const item = faturas[i];
    statusEl.textContent = `Enviando (${i + 1}/${faturas.length}): ${item.nome_cliente}`;
    detailEl.textContent = `WhatsApp: ${item.whatsapp} • Valor Solar: R$ ${fmtMoeda(item.valor_tacticus)}`;

    try {
      await apiFetch('/api/whatsapp/enviar', {
        method: 'POST',
        body: JSON.stringify({
          uc: item.uc,
          chave_periodo: state.periodoSelecionado,
          tipo: 'card',
          formato: 'png',
        }),
      });
      showToast(`Card enviado para ${item.nome_cliente}!`);
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(`Erro ao enviar para ${item.nome_cliente}: ${err.message}`, 'error');
    }

    if (i < faturas.length - 1 && !state.filaWhatsAppCancelada) {
      const waitSec = Math.floor(Math.random() * (37 - 23 + 1)) + 23;
      for (let s = waitSec; s > 0; s--) {
        if (state.filaWhatsAppCancelada) break;
        statusEl.textContent = `Aguardando intervalo anti-bloqueio (${s}s)...`;
        detailEl.textContent = `Próximo cliente (${i + 2}/${faturas.length}): ${faturas[i + 1].nome_cliente}`;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  state.filaWhatsAppRodando = false;
  banner.hidden = true;
  showToast(state.filaWhatsAppCancelada ? 'Fila de envio cancelada.' : 'Fila de envio concluída!');
}

// ─── ABA 2: HISTÓRICO COMPLETO E GRÁFICO POR UNIDADE ───────────────────────
function preencherFiltroClientesHistorico(faturas) {
  const sel = document.getElementById('filtroHistoricoUC');
  const valorAtual = sel.value;
  sel.innerHTML =
    '<option value="">Todas as Unidades Consumidoras (UCs)</option>' +
    faturas
      .map(
        c =>
          `<option value="${esc(c.uc)}">${esc(c.nome_cliente)} — UC ${esc(c.uc)}</option>`
      )
      .join('');
  if (valorAtual) sel.value = valorAtual;
}

async function carregarHistoricoCompleto() {
  const ucFiltro = document.getElementById('filtroHistoricoUC').value;
  const query = ucFiltro ? `?uc=${encodeURIComponent(ucFiltro)}` : '';
  const data = await apiFetch(`/api/historico${query}`);
  state.historicoCompleto = data.registros || [];

  renderGraficoClienteIndividual(state.historicoCompleto, ucFiltro);
  renderTabelaHistoricoCompleto(state.historicoCompleto);
}

function renderGraficoClienteIndividual(registros, ucFiltro) {
  const wrap = document.getElementById('graficoHistoricoClienteWrap');
  if (!ucFiltro || !registros.length) {
    wrap.innerHTML = '';
    return;
  }

  const cronologico = [...registros].reverse();
  const clienteNome = cronologico[0]?.nome_cliente || ucFiltro;
  const totalCons = cronologico.reduce((s, r) => s + Number(r.energia_consumida || 0), 0);
  const totalEcon = cronologico.reduce((s, r) => s + Number(r.economia_reais || 0), 0);
  const media = cronologico.length ? totalCons / cronologico.length : 0;

  const w = 920;
  const h = 210;
  const padX = 48;
  const padY = 24;
  const cW = w - padX * 2;
  const cH = h - padY * 2 - 16;
  const maxV = Math.max(100, ...cronologico.map(r => Number(r.energia_consumida || 0)));
  const slotW = cW / cronologico.length;
  const barW = Math.min(34, Math.max(16, slotW * 0.55));

  let bars = '';
  cronologico.forEach((r, idx) => {
    const v = Number(r.energia_consumida || 0);
    const bh = Math.max(4, (v / maxV) * cH);
    const bx = padX + idx * slotW + (slotW - barW) / 2;
    const by = padY + cH - bh;
    bars += `
      <g>
        <rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="5" fill="#087443"/>
        <text x="${bx + barW / 2}" y="${by - 6}" text-anchor="middle" fill="#087443" font-size="10.5" font-weight="800">${fmtKwh(v)}</text>
        <text x="${bx + barW / 2}" y="${padY + cH + 16}" text-anchor="middle" fill="#3a4a40" font-size="10.5" font-weight="700">${esc(r.periodo_label)}</text>
      </g>
    `;
  });

  wrap.innerHTML = `
    <div style="background:#f6faf7;border:1px solid var(--border-subtle);border-radius:14px;padding:1rem 1.2rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem;">
        <strong>Evolução de Consumo: ${esc(clienteNome)} (UC ${esc(ucFiltro)})</strong>
        <div style="font-size:0.84rem;color:var(--text-secondary)">
          Média Mensal: <strong>${fmtKwh(media)} kWh</strong> • Total Consumido: <strong>${fmtKwh(totalCons)} kWh</strong> • Economia Acumulada: <strong style="color:var(--solar-primary)">R$ ${fmtMoeda(totalEcon)}</strong>
        </div>
      </div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="200">
        <line x1="${padX}" y1="${padY + cH}" x2="${padX + cW}" y2="${padY + cH}" stroke="#cfe0d5" stroke-width="1.5"/>
        ${bars}
      </svg>
    </div>
  `;
}

function renderTabelaHistoricoCompleto(registros) {
  const tbody = document.getElementById('tbodyHistoricoCompleto');
  if (!registros.length) {
    tbody.innerHTML = '<tr><td colspan="10">Nenhum registro encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = registros
    .map(r => {
      const bClass =
        r.bandeira === 'VERDE'
          ? 'badge-verde'
          : r.bandeira === 'VERMELHA'
            ? 'badge-vermelha'
            : 'badge-amarela';
      return `
        <tr>
          <th scope="row">
            <span style="font-weight:800;color:var(--solar-primary)">${esc(r.periodo_label.toUpperCase())}</span>
            <div style="font-size:0.78rem;color:var(--text-main)">${esc(r.nome_cliente || r.cod_cliente)}</div>
          </th>
          <td>
            <div style="font-family:monospace;font-weight:700">${esc(r.uc)}</div>
            <div style="font-size:0.74rem;color:var(--text-secondary)">Med: ${esc(r.medidor || '-')}</div>
          </td>
          <td>${r.leitura_de !== null ? `${fmtKwh(r.leitura_de)} → ${fmtKwh(r.leitura_ate)}` : '-'}</td>
          <td><strong>${fmtKwh(r.energia_consumida)} kWh</strong></td>
          <td>${r.energia_injetada > 0 ? `<strong style="color:#087443">${fmtKwh(r.energia_injetada)} kWh</strong>` : '-'}</td>
          <td>${fmtKwh(r.kwh_compensado)} kWh</td>
          <td><span class="badge ${bClass}">${esc(r.bandeira)}</span></td>
          <td><strong>R$ ${fmtMoeda(r.valor_tacticus)}</strong></td>
          <td style="color:#087443;font-weight:700">R$ ${fmtMoeda(r.economia_reais)}</td>
          <td>
            <div class="action-btn-group">
              <button type="button" class="btn btn-secondary btn-sm btn-hist-preview" data-uc="${esc(r.uc)}" data-periodo="${esc(r.chave_periodo)}" data-modo="detalhada">
                📄 Fatura
              </button>
              <button type="button" class="btn btn-secondary btn-sm btn-hist-preview" data-uc="${esc(r.uc)}" data-periodo="${esc(r.chave_periodo)}" data-modo="card">
                🖼️ Card
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-hist-preview').forEach(btn => {
    btn.addEventListener('click', () => {
      abrirPreviewModal(btn.dataset.uc, btn.dataset.periodo, btn.dataset.modo);
    });
  });
}

// ─── ABA 3: IMPORTAÇÃO DO GMAIL E PDF ──────────────────────────────────────
function renderTabelaImportacoes(importacoes) {
  const tbody = document.getElementById('tbodyImportacoes');
  if (!importacoes.length) {
    tbody.innerHTML = '<tr><td colspan="7">Nenhuma importação registrada.</td></tr>';
    return;
  }
  tbody.innerHTML = importacoes
    .map(
      imp => `
      <tr>
        <th scope="row">#${imp.id} • <span class="badge badge-enviada">${esc(imp.origem)}</span></th>
        <td>
          <strong>${esc(imp.arquivo_nome || '-')}</strong>
          <div style="font-size:0.75rem;color:var(--text-secondary)">${esc(imp.assunto_email || imp.titular_relatorio || '')}</div>
        </td>
        <td>${esc(imp.periodo_descricao || '-')}</td>
        <td>${fmtKwh(imp.total_injetado)} / ${fmtKwh(imp.total_compensado)} kWh</td>
        <td><strong>${fmtKwh(imp.saldo_acumulado)} kWh</strong></td>
        <td>+${imp.qtd_registros_importados} novos / ${imp.qtd_registros_atualizados} atualiz.</td>
        <td>${esc(imp.created_at)}</td>
      </tr>
    `
    )
    .join('');
}

async function processarArquivoPdf(file) {
  if (!file) return;
  const infoPill = document.getElementById('arquivoPdfSelecionadoInfo');
  infoPill.hidden = false;
  infoPill.textContent = `Lendo e extraindo ${file.name}...`;

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Falha ao ler arquivo PDF.'));
    reader.readAsDataURL(file);
  });

  try {
    const bandeira = document.getElementById('selectBandeiraGlobal').value;
    const res = await apiFetch('/api/importar/pdf', {
      method: 'POST',
      body: JSON.stringify({
        pdfBase64: base64,
        arquivoNome: file.name,
        bandeira,
      }),
    });

    exibirResultadoImportacao(res.resultado);
    showToast(`PDF importado! ${res.resultado.inseridos} novos registros e ${res.resultado.atualizados} atualizados.`);
    await carregarOverview(res.resultado.periodoMaisRecente);
  } catch (err) {
    infoPill.textContent = `Erro: ${err.message}`;
    showToast(err.message, 'error');
  }
}

function exibirResultadoImportacao(res) {
  const box = document.getElementById('resultadoImportacaoBox');
  box.hidden = false;
  box.innerHTML = `
    <strong>✅ Relatório Processado com Sucesso!</strong>
    <div style="margin-top:0.35rem">
      Titular: <strong>${esc(res.header?.titular)}</strong> • Período: <strong>${esc(res.header?.periodo_descricao)}</strong><br/>
      Total de leituras extraídas: <strong>${res.totalRegistros}</strong> (${res.inseridos} novos períodos/UCs inseridos, ${res.atualizados} atualizados sem duplicidade).
    </div>
  `;
}

async function buscarEmailsNoGmail() {
  const container = document.getElementById('listaEmailsGmailContainer');
  const q = document.getElementById('inputGmailQuery').value;
  container.innerHTML = '<p class="muted-state">Conectando ao Gmail e buscando relatórios da Neoenergia...</p>';

  try {
    const data = await apiFetch(`/api/gmail/emails?q=${encodeURIComponent(q)}`);
    const emails = data.emails || [];
    if (!emails.length) {
      container.innerHTML = '<p class="muted-state">Nenhum e-mail encontrado para este filtro.</p>';
      return;
    }

    container.innerHTML = emails
      .map(
        e => `
        <div class="gmail-email-item">
          <div>
            <strong>${esc(e.subject)}</strong>
            <div style="font-size:0.76rem;color:var(--text-secondary)">${esc(e.from)} • ${esc(e.date)}</div>
            <div style="font-size:0.75rem;color:var(--solar-primary);margin-top:0.2rem">
              Anexos PDF: ${e.anexosPdf.map(a => esc(a.filename)).join(', ') || 'Nenhum PDF'}
            </div>
          </div>
          <div>
            ${
              e.anexosPdf.length > 0
                ? `<button type="button" class="btn ${e.jaImportado ? 'btn-secondary' : 'btn-primary'} btn-sm btn-import-gmail-item" data-msgid="${esc(e.id)}" data-attid="${esc(e.anexosPdf[0].attachmentId)}">
                    ${e.jaImportado ? '🔄 Reimportar PDF' : '📥 Importar PDF'}
                  </button>`
                : '<span class="badge badge-isenta">Sem PDF</span>'
            }
          </div>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.btn-import-gmail-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          btn.disabled = true;
          btn.textContent = 'Importando...';
          const bandeira = document.getElementById('selectBandeiraGlobal').value;
          const res = await apiFetch('/api/gmail/importar', {
            method: 'POST',
            body: JSON.stringify({
              messageId: btn.dataset.msgid,
              attachmentId: btn.dataset.attid,
              bandeira,
            }),
          });
          exibirResultadoImportacao(res.resultado);
          showToast(`Importado do Gmail (${res.arquivo})!`);
          await carregarOverview(res.resultado.periodoMaisRecente);
          await buscarEmailsNoGmail();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '📥 Importar PDF';
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="import-result-box" style="background:#fce8e6;border-color:#f5c2c0;color:#991b1b">${esc(err.message)}</div>`;
    showToast(err.message, 'error');
  }
}

// ─── ABA 4: CLIENTES & UNIDADES CONSUMIDORAS ───────────────────────────────
async function carregarClientes() {
  const data = await apiFetch('/api/clientes');
  state.clientes = data.clientes || [];
  const tbody = document.getElementById('tbodyClientes');

  tbody.innerHTML = state.clientes
    .map(c => {
      const contas = [c.tarifa_conta_1, c.tarifa_conta_2, c.tarifa_conta_3]
        .map(v => Number(v))
        .filter(v => Number.isFinite(v) && v > 0);
      const tarifaNeo = Number(c.tarifa_neoenergia || 1.11);
      const tarifaSol = Number(c.tarifa_tacticus || c.tarifa_personalizada || 0.72);
      const baseLabel = c.base_calculo === 'compensado' ? 'kWh Compensado' : 'Consumo Bruto';

      return `
      <tr>
        <th scope="row">
          <div style="font-size:0.86rem;line-height:1.25">${esc(c.nome_cliente)}</div>
          <div style="font-size:0.72rem;color:var(--text-secondary);font-weight:500;margin-top:0.15rem">
            📍 ${esc(c.localidade || '-')} • 📱 ${esc(c.whatsapp || '-')}
          </div>
        </th>
        <td>
          <div style="font-family:monospace;font-weight:700;font-size:0.83rem">${esc(c.uc)}</div>
          <div style="font-size:0.72rem;color:var(--text-secondary)">CC: ${esc(c.conta_contrato || '-')}</div>
        </td>
        <td style="white-space:nowrap">
          <div>Atual: <strong>${esc(c.medidor_atual || '-')}</strong></div>
          ${c.medidor_antigo ? `<div style="font-size:0.72rem;color:var(--text-muted)">Antigo: ${esc(c.medidor_antigo)}</div>` : ''}
        </td>
        <td>
          <span class="badge ${c.tipo_unidade === 'GERADORA' ? 'badge-verde' : 'badge-enviada'}">${esc(c.tipo_unidade)} (#${c.prioridade})</span>
        </td>
        <td style="white-space:nowrap">
          <strong style="color:var(--text-main);font-size:0.88rem">
            R$ ${tarifaNeo.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 4 })} / kWh
          </strong>
          <div style="font-size:0.71rem;color:var(--text-secondary)">
            ${
              contas.length > 0
                ? `Média (${contas.length}): ${contas.map(n => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })).join(' | ')}`
                : 'Tarifa direta atribuída'
            }
          </div>
        </td>
        <td style="white-space:nowrap">
          <strong style="color:var(--solar-primary);font-size:0.88rem">
            R$ ${tarifaSol.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} / kWh
          </strong>
        </td>
        <td>
          <div style="font-size:0.76rem;font-weight:700;white-space:nowrap">${esc(c.chave_pix || '50.713.702/0001-74')}</div>
          <div style="font-size:0.71rem;color:var(--text-secondary);white-space:nowrap">Base: ${esc(baseLabel)}</div>
        </td>
        <td style="white-space:nowrap"><strong>${fmtKwh(c.saldo_credito_acumulado)} kWh</strong></td>
        <td><span class="badge ${c.status_envio === 'ENVIAR' ? 'badge-amarela' : 'badge-paga'}">${esc(c.status_envio)}</span></td>
        <td>
          <button type="button" class="btn btn-primary btn-sm btn-editar-cliente" data-uc="${esc(c.uc)}">
            ✏️ Editar / Tarifas
          </button>
        </td>
      </tr>
    `;
    })
    .join('');

  tbody.querySelectorAll('.btn-editar-cliente').forEach(btn => {
    btn.addEventListener('click', () => {
      const cli = state.clientes.find(x => x.uc === btn.dataset.uc);
      if (cli) abrirModalCliente(cli);
    });
  });
}

function atualizarMediaContasModal(forcarCalculoSolar = true) {
  const c1 = parseFloat(document.getElementById('cliTarifaConta1').value);
  const c2 = parseFloat(document.getElementById('cliTarifaConta2').value);
  const c3 = parseFloat(document.getElementById('cliTarifaConta3').value);
  const validas = [c1, c2, c3].filter(v => Number.isFinite(v) && v > 0);
  const badge = document.getElementById('badgeMediaCalculada');
  const inputTarifaNeo = document.getElementById('cliTarifaNeoenergia');
  const inputTarifaTac = document.getElementById('cliTarifaTacticus');

  let tarifaNeoAtual = parseFloat(inputTarifaNeo.value) || 1.11;
  if (validas.length > 0) {
    tarifaNeoAtual = Number((validas.reduce((acc, v) => acc + v, 0) / validas.length).toFixed(4));
    inputTarifaNeo.value = tarifaNeoAtual;
  }

  const tarifaSolar20 = Number((tarifaNeoAtual * 0.8).toFixed(4));
  if (forcarCalculoSolar) {
    inputTarifaTac.value = tarifaSolar20;
  }

  const tSolAtual = Number(inputTarifaTac.value || tarifaSolar20);
  const pctDesconto =
    tarifaNeoAtual > 0 ? Math.max(0, ((tarifaNeoAtual - tSolAtual) / tarifaNeoAtual) * 100) : 20;
  const labelPct = pctDesconto.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

  const labelNeo = tarifaNeoAtual.toLocaleString('pt-BR', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  });
  const labelSol = tSolAtual.toLocaleString('pt-BR', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  });

  if (validas.length > 0) {
    badge.textContent = `Média (${validas.length} conta${validas.length > 1 ? 's' : ''}): R$ ${labelNeo}/kWh • Solar (-${labelPct}%): R$ ${labelSol}/kWh`;
  } else {
    badge.textContent = `Neoenergia: R$ ${labelNeo}/kWh • Solar (-${labelPct}%): R$ ${labelSol}/kWh`;
  }
}

function abrirModalCliente(cli = null) {
  const form = document.getElementById('formCliente');
  form.reset();
  const cfg = state.overview?.configuracoes || {};

  document.getElementById('cliNome').value = cli?.nome_cliente || '';
  document.getElementById('cliUC').value = cli?.uc || '';
  document.getElementById('cliContaContrato').value = cli?.conta_contrato || '';
  document.getElementById('cliPrioridade').value = cli?.prioridade ?? 1;
  document.getElementById('cliTipoUnidade').value = cli?.tipo_unidade || 'BENEFICIARIA';
  document.getElementById('cliMedidorAtual').value = cli?.medidor_atual || '';
  document.getElementById('cliMedidorAntigo').value = cli?.medidor_antigo || '';
  document.getElementById('cliWhatsApp').value = cli?.whatsapp || '5581';
  document.getElementById('cliLocalidade').value = cli?.localidade || '';
  document.getElementById('cliStatusEnvio').value = cli?.status_envio || 'ENVIAR';

  document.getElementById('cliTarifaConta1').value = cli?.tarifa_conta_1 ?? '';
  document.getElementById('cliTarifaConta2').value = cli?.tarifa_conta_2 ?? '';
  document.getElementById('cliTarifaConta3').value = cli?.tarifa_conta_3 ?? '';
  const tNeoInicial = Number(cli?.tarifa_neoenergia ?? cfg.tarifa_neoenergia ?? 1.11);
  const tSolSalva = Number(cli?.tarifa_tacticus ?? cli?.tarifa_personalizada ?? 0);
  document.getElementById('cliTarifaNeoenergia').value = tNeoInicial;
  document.getElementById('cliTarifaTacticus').value =
    tSolSalva > 0 ? tSolSalva : Number((tNeoInicial * 0.8).toFixed(4));
  document.getElementById('cliBaseCalculo').value =
    cli?.base_calculo || cfg.base_calculo || 'energia_consumida';
  document.getElementById('cliChavePix').value =
    cli?.chave_pix || cfg.chave_pix || '50.713.702/0001-74';
  document.getElementById('cliTelefoneContato').value =
    cli?.telefone_contato || cfg.telefone_contato || '(81) 9 8250-5444';

  atualizarMediaContasModal(false);
  document.getElementById('dialogCliente').showModal();
}

// ─── ABA 5: CONFIGURAÇÕES ──────────────────────────────────────────────────
function preencherFormularioConfiguracoes(cfg) {
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && v !== undefined && v !== null) el.value = v;
  };
  setVal('cfgTarifaNeoenergia', cfg.tarifa_neoenergia);
  setVal('cfgTarifaTacticus', cfg.tarifa_tacticus);
  setVal('cfgAdicionalVerde', cfg.adicional_verde);
  setVal('cfgAdicionalAmarela', cfg.adicional_amarela);
  setVal('cfgAdicionalVermelha', cfg.adicional_vermelha);
  setVal('cfgBaseCalculo', cfg.base_calculo);
  setVal('cfgChavePix', cfg.chave_pix);
  setVal('cfgTelefoneContato', cfg.telefone_contato);
  setVal('cfgGmailClientId', cfg.gmail_client_id);
  setVal('cfgGmailClientSecret', cfg.gmail_client_secret);
  setVal('cfgGmailRefreshToken', cfg.gmail_refresh_token);
  setVal('cfgGmailAccessToken', cfg.gmail_access_token);
  setVal('cfgSheetsId', cfg.sheets_spreadsheet_id);
  setVal('cfgEvolutionUrl', cfg.evolution_api_url);
  setVal('cfgEvolutionInstance', cfg.evolution_instance);
  setVal('cfgEvolutionKey', cfg.evolution_api_key);
  setVal('cfgWhatsappCaption', cfg.whatsapp_caption);
}

// ─── INICIALIZAÇÃO E EVENT LISTENERS ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupDialogFallbacks();
  UserInvalidFallback.init(document);

  // Abas
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => ativarAba(btn.dataset.tab));
  });

  // Seletor de Período Global
  document.getElementById('selectPeriodoGlobal').addEventListener('change', e => {
    carregarOverview(e.target.value);
  });

  // Seletor de Bandeira Tarifária do Período
  document.getElementById('selectBandeiraGlobal').addEventListener('change', async e => {
    try {
      const novaBandeira = e.target.value;
      await apiFetch('/api/periodo/recalcular', {
        method: 'POST',
        body: JSON.stringify({
          chave_periodo: state.periodoSelecionado,
          bandeira: novaBandeira,
        }),
      });
      showToast(`Bandeira ${novaBandeira} aplicada e faturas recalculadas!`);
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Botão rápido de abrir aba de importação
  document.getElementById('btnAbrirImportacaoRapida').addEventListener('click', () => {
    ativarAba('importacao');
  });

  // Controles do Modal de Preview
  document.getElementById('btnFecharPreview').addEventListener('click', () => {
    document.getElementById('dialogPreviewFatura').close();
  });
  document.getElementById('btnModoCard').addEventListener('click', () => {
    state.previewAtual.modo = 'card';
    atualizarConteudoPreviewModal();
  });
  document.getElementById('btnModoDetalhada').addEventListener('click', () => {
    state.previewAtual.modo = 'detalhada';
    atualizarConteudoPreviewModal();
  });
  document.getElementById('btnEnviarPreviewWhatsApp').addEventListener('click', () => {
    const { uc, chavePeriodo, modo } = state.previewAtual;
    enviarWhatsAppIndividual(uc, chavePeriodo, modo, uc);
  });

  // Marcar todos os clientes como ENVIAR
  document.getElementById('btnMarcarTodosEnviar').addEventListener('click', async () => {
    try {
      const faturas = state.overview?.faturasPeriodo || [];
      for (const f of faturas) {
        await apiFetch('/api/clientes', {
          method: 'POST',
          body: JSON.stringify({ ...f, status_envio: 'ENVIAR' }),
        });
      }
      showToast('Todos os clientes foram marcados como ENVIAR!');
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Disparo em lote WhatsApp
  document.getElementById('btnDispararLoteWhatsApp').addEventListener('click', () => {
    dispararFilaWhatsAppLote();
  });
  document.getElementById('btnCancelarFilaWhatsApp').addEventListener('click', () => {
    state.filaWhatsAppCancelada = true;
  });

  // Filtro da aba Histórico
  document.getElementById('filtroHistoricoUC').addEventListener('change', () => {
    carregarHistoricoCompleto();
  });

  // Upload de PDF (Dropzone + Input)
  const dropzone = document.getElementById('pdfDropzone');
  const fileInput = document.getElementById('inputPdfFile');
  document.getElementById('btnSelecionarArquivoPdf').addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) processarArquivoPdf(file);
  });
  fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) processarArquivoPdf(file);
  });

  // Importar texto colado manualmente
  document.getElementById('btnImportarTextoManual').addEventListener('click', async () => {
    const textoBruto = document.getElementById('textareaTextoRelatorio').value;
    if (!textoBruto.trim()) {
      showToast('Cole o texto do relatório antes de processar.', 'error');
      return;
    }
    try {
      const bandeira = document.getElementById('selectBandeiraGlobal').value;
      const res = await apiFetch('/api/importar/pdf', {
        method: 'POST',
        body: JSON.stringify({
          textoBruto,
          arquivoNome: 'Texto_Colado_Manual.txt',
          bandeira,
        }),
      });
      exibirResultadoImportacao(res.resultado);
      showToast('Texto processado e histórico atualizado!');
      await carregarOverview(res.resultado.periodoMaisRecente);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Gmail Busca e Importação Rápida
  document.getElementById('btnBuscarEmailsGmail').addEventListener('click', () => {
    buscarEmailsNoGmail();
  });
  document.getElementById('btnImportarUltimoEmailGmail').addEventListener('click', async () => {
    try {
      showToast('Buscando e importando o PDF mais recente do Gmail...');
      const bandeira = document.getElementById('selectBandeiraGlobal').value;
      const res = await apiFetch('/api/gmail/importar', {
        method: 'POST',
        body: JSON.stringify({ bandeira }),
      });
      exibirResultadoImportacao(res.resultado);
      showToast(`Resumo "${res.arquivo}" importado do Gmail com sucesso!`);
      await carregarOverview(res.resultado.periodoMaisRecente);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Clientes Modal e Sync Google Sheets
  document.getElementById('btnNovoCliente').addEventListener('click', () => abrirModalCliente(null));
  document.getElementById('btnFecharDialogCliente').addEventListener('click', () => {
    document.getElementById('dialogCliente').close();
  });
  document.getElementById('btnCancelarCliente').addEventListener('click', () => {
    document.getElementById('dialogCliente').close();
  });
  document.querySelectorAll('.input-media-conta').forEach(inp => {
    inp.addEventListener('input', () => atualizarMediaContasModal(true));
  });
  document.getElementById('cliTarifaNeoenergia').addEventListener('input', () => {
    const tNeo = parseFloat(document.getElementById('cliTarifaNeoenergia').value);
    if (Number.isFinite(tNeo) && tNeo > 0) {
      document.getElementById('cliTarifaTacticus').value = Number((tNeo * 0.8).toFixed(4));
    }
    atualizarMediaContasModal(false);
  });
  document.getElementById('cliTarifaTacticus').addEventListener('input', () => {
    atualizarMediaContasModal(false);
  });
  document.getElementById('formCliente').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    try {
      await apiFetch('/api/clientes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      document.getElementById('dialogCliente').close();
      showToast('Cliente, tarifas (média 3 contas) & PIX salvos e faturas recalculadas!');
      await carregarClientes();
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSincronizarSheets').addEventListener('click', async () => {
    try {
      showToast('Sincronizando com a planilha Clientes_Energia_Solar...');
      const res = await apiFetch('/api/clientes/sync-sheets', { method: 'POST' });
      showToast(`${res.sincronizados} clientes sincronizados do Google Sheets!`);
      await carregarClientes();
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Configurações Form
  document.getElementById('formConfiguracoes').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    try {
      await apiFetch('/api/configuracoes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('Configurações salvas e histórico recalculado!');
      await carregarOverview(state.periodoSelecionado);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnConectarGoogleOAuth').addEventListener('click', async () => {
    try {
      const fd = new FormData(document.getElementById('formConfiguracoes'));
      await apiFetch('/api/configuracoes', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(fd.entries())),
      });
      const { authUrl } = await apiFetch('/api/gmail/oauth-url');
      window.location.href = authUrl;
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Carrega dados iniciais
  await carregarOverview();
});

