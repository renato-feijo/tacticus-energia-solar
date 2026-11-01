import { getConfiguracoes, salvarConfiguracoes, getClientes, salvarCliente, db } from './db.mjs';
import { extrairTextoDePdfBuffer, parseResumoNeoenergia, formatarUC15, normalizarUC } from './neoenergiaParser.mjs';

/**
 * Obtém um access_token válido do Gmail (usando access_token direto ou renovando via refresh_token).
 */
export async function obterGmailAccessToken() {
  const cfg = getConfiguracoes();

  if (cfg.gmail_refresh_token && cfg.gmail_client_id && cfg.gmail_client_secret) {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.gmail_client_id,
        client_secret: cfg.gmail_client_secret,
        refresh_token: cfg.gmail_refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) {
        salvarConfiguracoes({ gmail_access_token: data.access_token });
        return data.access_token;
      }
    }
  }

  if (cfg.gmail_access_token) {
    return cfg.gmail_access_token.trim();
  }

  throw new Error(
    'Credenciais do Gmail OAuth2 não configuradas. Informe o Access Token ou configure Client ID, Client Secret e Refresh Token na aba Configurações (ou use o Upload Manual de PDF).'
  );
}

/**
 * Gera URL de autorização OAuth2 do Google para conectar Gmail e Google Sheets.
 */
export function gerarGoogleOAuthUrl(redirectUri) {
  const cfg = getConfiguracoes();
  if (!cfg.gmail_client_id) {
    throw new Error('Informe primeiro o Google Client ID nas configurações.');
  }
  const params = new URLSearchParams({
    client_id: cfg.gmail_client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ].join(' '),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Troca o código OAuth2 por access_token e refresh_token.
 */
export async function trocarCodigoOAuthGoogle(code, redirectUri) {
  const cfg = getConfiguracoes();
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.gmail_client_id,
      client_secret: cfg.gmail_client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error_description || data.error || 'Falha ao trocar código OAuth2.');
  }
  const updates = {};
  if (data.access_token) updates.gmail_access_token = data.access_token;
  if (data.refresh_token) updates.gmail_refresh_token = data.refresh_token;
  salvarConfiguracoes(updates);
  return data;
}

/**
 * Lista os e-mails recentes da Neoenergia no Gmail com anexos PDF.
 */
export async function listarEmailsNeoenergiaGmail(customQuery = null, maxResults = 10) {
  const token = await obterGmailAccessToken();
  const cfg = getConfiguracoes();
  const q = customQuery || cfg.gmail_query || 'from:neoenergia.com OR subject:"NEOENERGIA PERNAMBUCO" has:attachment filename:pdf';

  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('maxResults', String(maxResults));

  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listResp.json();
  if (!listResp.ok) {
    throw new Error(listData.error?.message || 'Erro ao buscar mensagens no Gmail.');
  }

  const messages = listData.messages || [];
  const detalhes = [];

  for (const msg of messages) {
    const msgResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!msgResp.ok) continue;
    const msgJson = await msgResp.json();
    const headers = msgJson.payload?.headers || [];
    const getHeader = name =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    // Procura partes com anexo PDF
    const anexosPdf = [];
    const visitarPartes = (parts = []) => {
      for (const p of parts) {
        if (
          p.filename &&
          (p.mimeType === 'application/pdf' || p.filename.toLowerCase().endsWith('.pdf')) &&
          p.body?.attachmentId
        ) {
          anexosPdf.push({
            filename: p.filename,
            mimeType: p.mimeType,
            attachmentId: p.body.attachmentId,
            size: p.body.size || 0,
          });
        }
        if (p.parts) visitarPartes(p.parts);
      }
    };
    visitarPartes(msgJson.payload?.parts || []);

    const jaImportado = db
      .prepare('SELECT id, created_at FROM importacoes WHERE gmail_message_id = ? LIMIT 1')
      .get(msg.id);

    detalhes.push({
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader('Subject') || '(Sem assunto)',
      from: getHeader('From'),
      date: getHeader('Date'),
      snippet: msgJson.snippet || '',
      anexosPdf,
      jaImportado: Boolean(jaImportado),
      importadoEm: jaImportado?.created_at || null,
    });
  }

  return detalhes;
}

/**
 * Baixa o anexo PDF de uma mensagem do Gmail, extrai o texto e faz o parse do Resumo da Neoenergia.
 */
export async function baixarEExtrairPdfGmail(messageId, attachmentId = null) {
  const token = await obterGmailAccessToken();

  const msgResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const msgJson = await msgResp.json();
  if (!msgResp.ok) {
    throw new Error(msgJson.error?.message || 'Não foi possível ler o e-mail no Gmail.');
  }

  const headers = msgJson.payload?.headers || [];
  const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';

  let targetAttachment = null;
  const visitarPartes = (parts = []) => {
    for (const p of parts) {
      if (
        p.filename &&
        (p.mimeType === 'application/pdf' || p.filename.toLowerCase().endsWith('.pdf')) &&
        p.body?.attachmentId
      ) {
        if (!attachmentId || p.body.attachmentId === attachmentId) {
          targetAttachment = {
            filename: p.filename,
            attachmentId: p.body.attachmentId,
          };
          return;
        }
      }
      if (p.parts) visitarPartes(p.parts);
    }
  };
  visitarPartes(msgJson.payload?.parts || []);

  if (!targetAttachment) {
    throw new Error('Nenhum anexo PDF encontrado neste e-mail do Gmail.');
  }

  const attResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${targetAttachment.attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const attData = await attResp.json();
  if (!attResp.ok || !attData.data) {
    throw new Error(attData.error?.message || 'Erro ao baixar o anexo PDF do Gmail.');
  }

  // O Gmail retorna base64url (- e _)
  const base64Standard = attData.data.replace(/-/g, '+').replace(/_/g, '/');
  const pdfBuffer = Buffer.from(base64Standard, 'base64');
  const rawText = extrairTextoDePdfBuffer(pdfBuffer);
  const parsed = parseResumoNeoenergia(rawText, getClientes());

  return {
    filename: targetAttachment.filename,
    subject,
    messageId,
    rawText,
    parsed,
  };
}

/**
 * Sincroniza clientes a partir da planilha Google Sheets (via OAuth API ou exportação pública CSV).
 */
export async function sincronizarClientesGoogleSheets() {
  const cfg = getConfiguracoes();
  const spreadsheetId = cfg.sheets_spreadsheet_id || '1_liYvkIu6gcDbxMec6IC48xWdE_2A7Qxkmdg-MEz5nk';
  const gid = cfg.sheets_gid || '0';

  let rows = [];

  // 1) Tenta primeiro via Google Sheets API v4 se houver token OAuth
  if (cfg.gmail_access_token || cfg.gmail_refresh_token) {
    try {
      const token = await obterGmailAccessToken();
      const apiResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Cadastro!A1:H100`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (apiResp.ok) {
        const data = await apiResp.json();
        const values = data.values || [];
        if (values.length > 1) {
          const headers = values[0].map(h => String(h).trim());
          rows = values.slice(1).map(line => {
            const obj = {};
            headers.forEach((h, i) => {
              obj[h || `Column_${i + 1}`] = line[i] ?? '';
            });
            return obj;
          });
        }
      }
    } catch {
      // Fallback para export CSV
    }
  }

  // 2) Fallback: tenta baixar CSV se a planilha permitir leitura por link
  if (rows.length === 0) {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
    const resp = await fetch(csvUrl);
    if (!resp.ok) {
      throw new Error(
        `Não foi possível acessar a planilha (${resp.status}). Conecte o Google OAuth2 nas Configurações ou torne a planilha acessível.`
      );
    }
    const csvText = await resp.text();
    const lines = csvText.split(/\r?\n/).filter(l => l.trim());
    if (lines.length > 1) {
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
      rows = lines.slice(1).map(l => {
        const cols = l.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const obj = {};
        headers.forEach((h, i) => {
          obj[h || `Column_${i + 1}`] = cols[i] ?? '';
        });
        return obj;
      });
    }
  }

  let sincronizados = 0;
  for (const r of rows) {
    const cod = r.Cod_Cliente || r.UC || r.uc;
    if (!cod) continue;
    salvarCliente({
      uc: formatarUC15(cod),
      cod_cliente: normalizarUC(cod),
      conta_contrato: r.Conta_Contrato || r['Column 7'] || r.Column_7 || '',
      prioridade: Number(r.Prioridade ?? 0),
      nome_cliente: r.Nome_Cliente || `Cliente ${cod}`,
      whatsapp: r.WhatsApp || '',
      localidade: r.Localidade || '',
      status_envio: r.Status || 'ENVIAR',
    });
    sincronizados++;
  }

  return { sincronizados, totalLinhas: rows.length };
}

/**
 * Envia o Card ou Fatura por WhatsApp usando a Evolution API configurada.
 */
export async function enviarMidiaEvolutionWhatsApp({
  numeroWhatsApp,
  bufferMidia,
  nomeArquivo = 'fatura-energia-solar.png',
  mimeType = 'image/png',
  legenda = null,
}) {
  const cfg = getConfiguracoes();
  const baseUrl = String(cfg.evolution_api_url || 'https://evolution.tacticus.com.br').replace(/\/+$/, '');
  const instance = String(cfg.evolution_instance || 'Energia_Solar').trim();
  const apiKey = String(cfg.evolution_api_key || '').trim();
  const caption = legenda || cfg.whatsapp_caption || 'Sua Conta de Energia Chegou!';

  const numeroLimpo = String(numeroWhatsApp || '').replace(/\D/g, '');
  if (!numeroLimpo) {
    throw new Error('Cliente não possui número de WhatsApp válido cadastrado.');
  }
  if (!apiKey) {
    throw new Error('API Key da Evolution API não configurada.');
  }

  const endpoint = `${baseUrl}/message/sendMedia/${encodeURIComponent(instance)}`;
  const formData = new FormData();
  formData.append('number', numeroLimpo);
  formData.append('mediatype', mimeType === 'application/pdf' ? 'document' : 'image');
  formData.append('caption', caption);
  formData.append(
    'file',
    new Blob([bufferMidia], { type: mimeType }),
    nomeArquivo
  );

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: apiKey,
    },
    body: formData,
  });

  const respText = await resp.text();
  let respJson = {};
  try {
    respJson = JSON.parse(respText);
  } catch {
    respJson = { raw: respText };
  }

  if (!resp.ok) {
    throw new Error(
      `Falha na Evolution API (${resp.status}): ${respJson.message || respJson.error || respText.slice(0, 200)}`
    );
  }

  return respJson;
}

