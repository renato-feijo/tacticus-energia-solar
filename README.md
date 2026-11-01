# Energia Solar — Faturamento Automatizado (Tacticus)

Aplicação **Web Full-Stack** (Node.js + SQLite + Interface Web) e automação em [n8n](https://n8n.io) que importam o relatório de **Faturamento Microgeração** da Neoenergia (via Gmail OAuth2 ou upload de PDF), convertem em **histórico de consumo estruturado por Unidade Consumidora (UC)**, geram o **Card de Cobrança (PNG 1200×600)** e a **Fatura Detalhada com Gráfico de Histórico (PNG/PDF 1200×1360)**, e enviam por **WhatsApp (Evolution API)**.

## Aplicação Web Full-Stack

### Como iniciar

```bash
npm start
# Acesse em: http://localhost:3456
```

### Funcionalidades da Aplicação Web
- **Importação Inteligente Neoenergia (Gmail OAuth2 + Upload PDF)**:
  - Busca automática de e-mails da Neoenergia (`atendimentoclientesgd.pe@neoenergia.com` / `Label_26`) via API do Gmail ou upload direto do PDF.
  - Parser determinístico do relatório *Faturamento Microgeração* que extrai cabeçalho, leituras de medidor (`De → Até`), correlação automática de troca de medidores para as UCs atuais, tabela dos últimos 13/14 meses (`Energia Consumida`, `Energia Injetada`, `Energia Faturada`, `kWh Compensado`, `Crédito`) e saldos de crédito por unidade sem duplicar períodos já importados.
- **Banco de Dados SQLite Nativo (`data/energia_solar.sqlite`)**:
  - Armazena histórico completo de consumo, clientes/UCs, saldos de crédito, status de pagamento (`PENDENTE`, `ENVIADA`, `PAGA`, `ISENTA`) e log de importações.
  - Sincronização sob demanda com a planilha Google Sheets `Clientes_Energia_Solar` e exportação completa em CSV/Excel.
- **Geração de Fatura e Card Solar**:
  - **Card Compacto (1200×600 px)**: Mantém o layout oficial da Tacticus (SVG/PNG).
  - **Fatura Detalhada com Histórico (1200×1360 px)**: Inclui dados da UC, Conta Contrato, Medidor, Leituras, Economia no Mês e Acumulada, Gráfico de Barras dos últimos 12 meses com linha de média e tabela dos últimos 6 ciclos (SVG, PNG e PDF).
- **Disparo WhatsApp (Evolution API)**:
  - Envio individual em 1 clique ou fila em lote para clientes com `Status = ENVIAR` respeitando o intervalo aleatório anti-bloqueio (23 a 37 segundos).

---

## Como funciona (Workflow Original n8n)

```
Formulário (bandeira tarifária)
   ├─► Gmail: busca o e-mail da fatura (label) e baixa o PDF
   │      └─► Extrai texto do PDF ─► Agente de IA (GPT-4.1-mini) extrai Período / UC / Consumo kWh
   │             └─► Code: calcula valores e define bandeira ─────────────┐
   │                                                                      ▼
   └─► Google Sheets "Clientes_Energia_Solar" (aba Cadastro)            Merge por Cod_Cliente
          └─► IF Status = "ENVIAR" ────────────────────────────────────►│
                                                                         ▼
                                  Loop (um cliente por vez) ─► espera aleatória 23–37 s
                                     └─► Logo (Base64) ─► Code: gera card SVG ─► Edit Image (PNG 1200×600)
                                            └─► Evolution API: envia no WhatsApp ─► Sheets: Status = "ENVIADO"
```

1. Quem opera abre o formulário **Faturamento Energia Solar** e escolhe a bandeira vigente (`VERDE`, `AMARELA` ou `VERMELHA`).
2. O fluxo busca o e-mail mais recente da fatura, extrai o PDF e a IA devolve o consumo (kWh) de cada UC no período mais recente.
3. Em paralelo, lê a planilha de clientes e mantém apenas quem está com `Status = ENVIAR`.
4. Os dois lados são unidos pelo código do cliente (`Cod_Cliente` = UC).
5. Para cada cliente, gera o card, envia pelo WhatsApp e marca a linha como `ENVIADO`.

## Regras de cálculo

Definidas no node **Code in JavaScript1** do workflow:

| Item | Valor |
|---|---|
| Tarifa Neoenergia | R$ 1,11 / kWh |
| Tarifa Tacticus (solar) | R$ 0,90 / kWh |
| Adicional bandeira Verde | R$ 0,00 / 100 kWh |
| Adicional bandeira Amarela | R$ 1,885 / 100 kWh |
| Adicional bandeira Vermelha | R$ 4,463 / 100 kWh |

```
adicional          = (consumo / 100) × adicional_da_bandeira
Valor_Calculado    = consumo × 1,11 + adicional     # o que pagaria à Neoenergia
Valor_Com_Desconto = consumo × 0,90 + adicional     # com energia solar
Economia           = Valor_Calculado − Valor_Com_Desconto
```

Para mudar tarifas ou adicionais, edite as constantes `tarifaNeoenergia`, `tarifaTacticus` e `tabelaBandeiras` nesse node.

## Estrutura do projeto

| Caminho | Descrição |
|---|---|
| [json/Energia_Solar_Faturamento.json](json/Energia_Solar_Faturamento.json) | Workflow n8n completo (importar em *Workflows → Import from File*) |
| [js/Card_Energia_Solar_n8n_v3.js](js/Card_Energia_Solar_n8n_v3.js) | Código do node **Gerar Card SVG** (versão 3), mantido aqui para edição fora do n8n |
| [Prompt Criação de Imagem](Prompt%20Cria%C3%A7%C3%A3o%20de%20Imagem) | Prompt de design original do card (layout, cores, textos, placeholders) |
| [images/](images/) | Logos da Tacticus (JPEG/PNG), `logo-base64.txt` e exemplos de cards gerados |

## O card gerado

Card horizontal 1200×600 px com cabeçalho verde (logo, título e período), dados do cliente, comparação **consumo do mês → valor Neoenergia**, destaque do **valor com energia solar** e **economia do mês**, observação da bandeira tarifária e rodapé com PIX e WhatsApp.

O node **Gerar Card SVG** espera por item:

| Campo | Obrigatório | Descrição |
|---|---|---|
| `Periodo`, `Nome_Cliente`, `Localidade` | sim | Textos do cabeçalho e dados do cliente |
| `Consumo_kWh`, `Valor_Calculado`, `Valor_Com_Desconto` | sim | Aceita número ou formato BR (`1.234,56`, com ou sem `R$`) |
| `Bandeira_Tarifaria` | não | `VERDE` \| `AMARELA` \| `VERMELHA` (padrão `AMARELA`) |
| `Cor_Bandeira`, `Cor_Texto_Bandeira` | não | Sobrescrevem as cores da bandeira |
| `Observacao_Bandeira` | não | Texto da nota abaixo do box central |
| `Logo_Base64`, `Logo_Mime` | não | Logo em Base64 puro ou data URI; sem logo, usa um placeholder |

Saída: JSON com valores formatados e `binary.card` com `card-pagamento.svg`, convertido para PNG pelo node **Edit Image**.

## Pré-requisitos

- n8n com os nodes de Form Trigger, Gmail, Google Sheets, Extract from File, Edit Image e LangChain/OpenAI.
- Credenciais configuradas no n8n: **Gmail** (OAuth), **Google Sheets** (OAuth) e **OpenAI**.
- Label do Gmail aplicada aos e-mails de fatura (o node **Buscar E-mail Fatura** filtra por `labelIds`; ajuste para a label do seu Gmail).
- Instância da **Evolution API** com a instância `Energia_Solar` conectada ao WhatsApp.
- Planilha Google **Clientes_Energia_Solar**, aba **Cadastro**, com as colunas:

  | Cod_Cliente | Prioridade | Nome_Cliente | WhatsApp | Localidade | Status |
  |---|---|---|---|---|---|

  `Cod_Cliente` deve ser igual à UC que aparece na fatura. `Status = ENVIAR` marca quem receberá o card; após o envio vira `ENVIADO`.

## Como usar

1. Importe o workflow e reconecte as credenciais e a planilha.
2. Na planilha, marque `ENVIAR` nos clientes do mês.
3. Garanta que o e-mail com a fatura em PDF está na caixa de entrada com a label correta.
4. Abra o formulário do trigger, selecione a bandeira tarifária e clique em **Iniciar Faturamento**.
5. Acompanhe a execução; os envios saem com intervalo aleatório de 23 a 37 segundos para evitar bloqueio no WhatsApp.

## Atenção / segurança

- O JSON exportado do workflow contém a **API key da Evolution API em texto puro** no node `Enviar_WhatsApp`. Troque-a (rotacione na Evolution) e passe a usar uma credencial do n8n ou variável de ambiente antes de versionar ou compartilhar o arquivo.
- O JSON também embute o logo em Base64 e IDs da planilha; revise antes de compartilhar.
- Não há controle de versão (Git) neste diretório ainda.

## Limitações conhecidas

- O workflow só processa o **período mais recente** encontrado no PDF.
- A extração depende de um LLM; confira o resultado de `Consumo_kWh` em execuções novas ou quando o layout da fatura mudar.
- Tarifas e adicionais das bandeiras são fixos no código e precisam ser atualizados manualmente quando a ANEEL/Neoenergia reajustar.
- O texto de observação do prompt original cita "maio de 2026"; o workflow atual gera a observação dinamicamente a partir da bandeira e do período.
