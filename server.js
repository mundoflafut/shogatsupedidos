// ═══════════════════════════════════════════════════════════
// SHOGATSU · Servidor de Pedidos Online
// Node.js puro (sem dependências) — http, fs, crypto
// ═══════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const os = require('os');

const PORT = process.env.PORT || 3000;
// IMPORTANTE: por padrão os dados ficam numa pasta ao lado do server.js, que é APAGADA a cada novo
// deploy no Render (o disco do serviço web não é persistente). Pra não perder pedidos/clientes/
// configurações, configure um Disco Persistente no Render e aponte DATA_DIR pra ele (veja instruções
// no README.md, seção "Persistência de dados no Render").
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(PUBLIC_DIR, 'uploads');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const RESERVATIONS_FILE = path.join(DATA_DIR, 'reservations.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
// v79: inscrições push do PAINEL (loja) — separadas das inscrições dos CLIENTES (PUSH_SUBS_FILE).
// Cada aparelho que ativa (PC da loja, celular do dono, etc.) vira uma entrada aqui; quando chega
// pedido novo, manda pra TODAS ao mesmo tempo — é isso que resolve "alerta simultâneo PC + celular".
const ADMIN_PUSH_SUBS_FILE = path.join(DATA_DIR, 'admin-push-subs.json');
// v79: campanhas de push AGENDADAS/RECORRENTES (uma vez, diária, semanal ou mensal) — ver
// checkScheduledPush() perto do fim do arquivo, que roda a cada minuto.
const SCHEDULED_PUSH_FILE = path.join(DATA_DIR, 'scheduled-push.json');
const COURIERS_FILE = path.join(DATA_DIR, 'couriers.json'); // v32: pré-cadastro de motoboys
// v43: Shogatsu Custos, antes um programa separado, agora integrado direto no painel —
// mesma pasta de dados, mesmo login, mesma sessão.
const INGREDIENTES_FILE = path.join(DATA_DIR, 'ingredientes.json');
const FICHAS_TECNICAS_FILE = path.join(DATA_DIR, 'fichas-tecnicas.json');
const CUSTOS_CONFIG_FILE = path.join(DATA_DIR, 'custos-config.json');
// v91 — fila de sugestões da IA (novos produtos, alterações, preço, ficha, badge) aguardando
// aprovação humana. Nada aqui é aplicado ao cardápio/config sozinho — ver seção "CENTRAL DE
// APROVAÇÕES DA IA" mais abaixo.
const APROVACOES_IA_FILE = path.join(DATA_DIR, 'aprovacoes-ia.json');
const DELETE_LOG_FILE = path.join(DATA_DIR, 'delete-log.json'); // v32: histórico de exclusões de pedidos
const PERMISSION_LOG_FILE = path.join(DATA_DIR, 'permission-log.json'); // v109: histórico de alteração de permissões de usuário
const CONTATOS_IMPORTADOS_FILE = path.join(DATA_DIR, 'contatos-importados.json'); // v56: contatos importados de CSV/vCard/txt, separado dos clientes reais (que vêm de pedidos)
const ATENDIMENTO_FILE = path.join(DATA_DIR, 'atendimento.json'); // v57: conversas do chat (IA e/ou atendente humano)
// v60: sessões de login persistidas em disco (+ Supabase, ver FILE_TO_KEY) — antes viviam só em
// memória (Map), e como o disco do Render é apagado a cada deploy e o processo reinicia, TODO
// login válido virava inválido de uma hora pra outra; o painel então recebia 401 na primeira
// chamada de API e disparava doLogout() sozinho, que apaga o usuário/senha salvos no navegador —
// dava a impressão de "login e senha apagados" mesmo sem o usuário ter feito nada de errado.
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// v60: log de falhas de impressão (impressão remota/automática) — fica em disco pra dar pra
// conferir depois o que falhou e por quê, além do aviso mostrado na hora pra quem clicou em imprimir.
const PRINT_LOG_FILE = path.join(DATA_DIR, 'print-log.json');
// v98 — AI ROUTER: cache de leitura de imagem (evita reanalisar a mesma foto de nota fiscal/
// catálogo duas vezes) e log de uso da IA (provedor, modelo, tempo, erro, fallback usado — NUNCA
// a chave de API). Ver seção "AI ROUTER" mais abaixo, perto de chamarIA().
const IA_CACHE_FILE = path.join(DATA_DIR, 'ia-cache.json');
const IA_LOG_FILE = path.join(DATA_DIR, 'ia-log.json');
const webpush = require('./webpush');

// ═══════════════════════════════════════════════════════════
// v44: VERSÃO DE BUILD — sistema de atualização automática
// A cada deploy (Render/GitHub) o processo do Node sobe do zero, então calcular a versão UMA
// VEZ aqui no boot já basta: ela muda sozinha a cada novo deploy, sem precisar de nenhum passo
// manual. Prioridade: commit do Git (Render expõe automaticamente em RENDER_GIT_COMMIT; local
// tentamos ler via `git rev-parse` como fallback) > pacote + horário de início do processo.
// Isso NÃO mexe em login, pedidos, cardápio nem nada que já funciona — é só uma etiqueta pro
// front-end saber quando existe uma versão mais nova publicada (ver GET /api/version abaixo e
// public/version-check.js).
function computeBuildVersion() {
  const commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.SOURCE_VERSION;
  if (commit) return commit.slice(0, 12);
  try {
    const { execSync } = require('child_process');
    const out = execSync('git rev-parse --short=12 HEAD', { cwd: __dirname, timeout: 2000 }).toString().trim();
    if (out) return out;
  } catch (e) { /* sem git disponível (ex: build sem .git) — usa o fallback abaixo */ }
  // v63 — BUG CORRIGIDO (causa raiz do "login fica atualizando e apaga tudo"): esse fallback
  // usava 'boot-' + Date.now(), um valor que muda a CADA reinício do processo — mesmo sem
  // nenhum deploy novo (o servidor caiu e voltou sozinho, o plano grátis do Render "dormiu" e
  // acordou de novo, ou há mais de uma instância rodando ao mesmo tempo). A cada reinício, o
  // front-end (public/version-check.js) achava que existia uma versão nova publicada e
  // recarregava a página sozinha — às vezes bem no meio da pessoa digitando usuário/senha,
  // apagando tudo. Agora usa a data de modificação do próprio server.js, que só muda de
  // verdade quando o código é reescrito por um deploy real — reinícios do processo sem deploy
  // novo passam a gerar sempre o mesmo valor, e o reload deixa de disparar à toa.
  try {
    const stat = fs.statSync(__filename);
    return 'file-' + Math.floor(stat.mtimeMs).toString(36);
  } catch (e) { /* ambiente sem acesso ao arquivo — não deveria acontecer em produção */ }
  return 'sem-versao';
}
const BUILD_COMMIT = computeBuildVersion();
const BUILD_STARTED_AT = new Date().toISOString();
let PKG_VERSION = '1.0.0';
try { PKG_VERSION = require('./package.json').version || PKG_VERSION; } catch (e) { /* mantém o padrão acima */ }
// v63 — BUG CORRIGIDO: antes a versão usada pra comparação (APP_VERSION) incluía o horário
// exato em que o PROCESSO subiu (new Date().toISOString()), não do deploy em si — ou seja,
// mudava a cada reinício do servidor mesmo sem nenhum código novo. Cada reinício (queda,
// cold start do plano grátis, deploy de zero-downtime com duas instâncias sobrepostas por
// alguns segundos) fazia o front-end pensar que saiu uma atualização e recarregar a tela de
// todo mundo sozinha — inclusive no meio do login. Agora a versão depende só do código
// (BUILD_COMMIT/PKG_VERSION), fica idêntica em qualquer processo rodando o mesmo deploy, e só
// muda quando o código muda de verdade. BUILD_STARTED_AT continua disponível à parte (retornado
// em /api/version) só como informação, sem entrar na comparação que decide recarregar.
const APP_VERSION = PKG_VERSION + '-' + BUILD_COMMIT;

// ─── Config / Menu padrão (usados só na primeira execução) ───
const DEFAULT_CFG = {
  whats: '552227641333', storePhone: '(22) 2764-1333', fee: 8, min: 60,
  name: 'Shogatsu Culinária Oriental', days: 'Ter–Dom',
  time: '40–60 min', timeRetirada: '20–30 min', addr: 'Av. Gov. Roberto Silveira, 109 · Costazul · Rio das Ostras · CEP 22896-155',
  hours: '18h30–23h', open: 1,
  // ── Auto-abertura/fechamento por horário (se ativado, cfg.open passa a ser calculado sozinho) ──
  schedule: { enabled: false, openTime: '18:00', closeTime: '23:00' },
  // v45: horário POR DIA DA SEMANA — usado pra validar agendamento de delivery e reservas
  // (avisa "fechado" no dia certo, e trava o relógio dentro do horário de funcionamento
  // daquele dia). Índice 0 = domingo, 1 = segunda... igual Date.prototype.getDay(). Por
  // padrão segue o texto "Ter–Dom" que já existia (fechado só na segunda), com o mesmo
  // horário de cfg.schedule pros dias abertos — o admin pode customizar dia a dia depois.
  weekSchedule: [
    { open: true, openTime: '18:00', closeTime: '23:00' },  // domingo
    { open: false, openTime: '18:00', closeTime: '23:00' }, // segunda
    { open: true, openTime: '18:00', closeTime: '23:00' },  // terça
    { open: true, openTime: '18:00', closeTime: '23:00' },  // quarta
    { open: true, openTime: '18:00', closeTime: '23:00' },  // quinta
    { open: true, openTime: '18:00', closeTime: '23:00' },  // sexta
    { open: true, openTime: '18:00', closeTime: '23:00' }   // sábado
  ],
  adminPass: 'shogatsu2026',
  masterPass: 'shogatsuMaster2026',
  // ── Usuários do painel (login por usuário + senha, com nível de acesso) ──
  // master: acesso total, inclusive gerenciar outros usuários.
  // admin: acesso total ao painel, exceto gerenciar usuários.
  // vendas: só Dashboard, Pedidos e Kanban — pra quem só precisa bater pedido no balcão.
  users: [
    { username: 'master', password: 'shogatsuMaster2026', role: 'master' },
    { username: 'admin', password: 'shogatsu2026', role: 'admin' }
  ],
  logoUrl: '',
  // v70: avatar do Chat Express agora é separado da logo geral da marca (logoUrl acima) — o
  // restaurante pode usar um mascote/ícone diferente no chat sem mexer na logo do cabeçalho.
  // Cai pra logoUrl, e depois pro ícone padrão do sistema, se estiver vazio.
  chatAvatarUrl: '',
  print: 0,                     // 1 = imprime automaticamente as vias ao chegar um pedido novo
  autoAcceptOrders: 0,          // v55: 1 = pedido novo já nasce ACEITO sozinho (pula o clique em "Aceitar Pedido"), com número de ficha já atribuído — pensado pra combinar com impressão automática (vias já saem com o número certo, sem ninguém precisar tocar em nada)
  autoAcceptReservations: 0,    // v78: 1 = reserva nova já nasce CONFIRMADA sozinha (pula o clique em "Confirmar" no painel)
  sound: 1,                     // 1 = toca alerta sonoro ao chegar pedido novo
  customerAlertSound: 'classico', // som tocado no app do cliente a cada aviso — pode ser um dos 5 prontos (classico|suave|dupla|sino|oriental) ou "custom:<id>" apontando pra um item de customCustomerAlertSounds
  customCustomerAlertSounds: [],  // v82: sons enviados pelo admin (upload) — cada item { id, name, url }, url vem de POST /api/upload (áudio)
  labels: {                     // textos dos botões/status do painel, customizáveis pelo admin
    actionNovo: 'Aceitar Pedido',
    actionPrep: 'Marcar Pronto',
    actionPronto: 'Confirmar Entrega',
    colNovo: 'Novos',
    colPrep: 'Preparando',
    colPronto: 'Pronto',
    colEntregue: 'Entregue',
    btnCancel: 'Cancelar',
    btnPrint: 'Imprimir',
  },
  pixKey: '', pixName: 'Shogatsu Culinaria Oriental', pixCity: 'RIO DAS OSTRAS',
  // ── Confirmação automática de PIX via gateway — OPCIONAL, exige conta própria e paga no provedor.
  // Sem isso configurado, o PIX continua funcionando exatamente como antes: QR/copia-e-cola com valor
  // exato, e a loja confere o recebimento manualmente (ou usa o botão "Marcar como pago" no painel).
  pixGateway: {
    enabled: false,
    provider: 'mercadopago', // por enquanto só Mercado Pago tem o webhook pronto abaixo
    accessToken: ''           // Access Token de produção da sua conta Mercado Pago
  },
  // ── Impressão do comprovante ──
  printFont: 'Verdana, sans-serif',      // 'monospace' | 'sans-serif' | 'serif' | outras opções na tela de config
  // v126 — BUG CORRIGIDO ("ajuste padrão de tamanho pra caber na bobina 80mm"): o padrão de
  // fábrica era 20px, mas 10-17px é a faixa que a impressora térmica trata como "tamanho
  // normal dela" (ver tamanhoImpressaoTermica() logo abaixo) — 18px ou mais já liga o
  // dobro de altura (GS ! n). Ou seja: TODA instalação nova, sem ninguém mexer em nada,
  // já saía imprimindo cada comanda com o dobro da altura normal, gastando o dobro de
  // bobina em cada impressão. 14px é o tamanho de referência usado em todo o resto do
  // sistema (ver `scale = ps/14` em public/painel.html) — agora é também o padrão de
  // fábrica, pra uma instalação nova já imprimir no tamanho normal da impressora até
  // alguém decidir aumentar de propósito em Configurações → Central de Impressão.
  printSize: 14,                // tamanho da fonte em px
  printColor: '#000000',        // cor do texto
  // v126 — NOVO ("ajuste pra caber na bobina 80mm bematech"): até aqui a largura usada pra
  // alinhar valores à direita e desenhar as linhas tracejadas na impressão direta (USB/rede,
  // sem Agente Local) era um número FIXO de 32 colunas — que é o certo pra bobina de 58mm,
  // mas deixa uma bobina de 80mm com bem menos texto por linha do que ela realmente
  // comporta (a impressora tem espaço de sobra, mas o sistema nunca usava). Esse campo deixa
  // a pessoa escolher a largura real da bobina que ela tem — 80mm (48 colunas, padrão de
  // fábrica) ou 58mm (32 colunas) — e o texto passa a ocupar a largura certa em ambos os
  // casos. Ver printCols() logo abaixo de ESC.
  printWidth: '80mm',           // '58mm' (32 colunas) | '80mm' (48 colunas)
  // ── Logotipo ──
  logoShape: 'retangular',      // 'redondo' | 'quadrado' | 'retangular'
  logoSize: 40,                  // altura em px
  dishPhotoSize: 80,             // v33: tamanho (px) da foto do prato pro cliente
  menuFontScale: 1,              // v33: escala da fonte do cardápio (0.85 a 1.3)
  // ── Impressoras por estação (vias separadas) ──
  // prepTime = tempo médio de preparo dessa estação, em minutos, usado para calcular
  // a previsão de saída automática na comanda (Entrada + prepTime = Previsão de saída).
  stations: {
    caixa:     { label: 'Caixa',     icon: '🧾', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 0, active: true },
    cozinha:   { label: 'Cozinha',   icon: '🍳', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 20, active: true },
    sushibar:  { label: 'Sushibar',  icon: '🍣', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 15, active: true },
    bar:       { label: 'Bar',       icon: '🍹', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 8, active: true },
    // v129 — NOVO ("via do motoboy/expedição deve mostrar cliente/endereço/pagamento, não a
    // lista de itens como cozinha/sushibar"): campo `kind: 'dispatch'` marca essas duas vias
    // como "despacho" — usa o MESMO layout de dados de entrega da via do Caixa (cliente,
    // telefone, endereço completo, referência, forma de pagamento, troco, motoboy, horário de
    // saída), só que SEM os dados financeiros internos (custo/margem não existem nesse
    // layout de qualquer forma) e sem a lista de itens do pedido — quem está saindo pra
    // entregar não precisa conferir prato por prato, só pra onde ir e quanto cobrar. Qualquer
    // via SEM "kind" (cozinha, sushibar, bar, ou uma via customizada nova) continua no layout
    // de PRODUÇÃO de sempre (lista de itens). "caixa" é sempre comprovante — nunca usa este
    // campo. Ver isCaixa/kind mais abaixo em POST /api/print.
    delivery:  { label: 'Delivery',  icon: '🛵', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 0, active: true, kind: 'dispatch' },
    expedicao: { label: 'Expedição', icon: '📦', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 5, active: true, kind: 'dispatch' }
    // v46: método "automatica" — imprime sozinho, sem abrir navegador nem pedir confirmação,
    // através do Agente Local de Impressão (print-agent/), que roda num computador dentro da
    // loja ligado na impressora. Ver POST /api/print abaixo e print-agent/print-agent.js.
    // v49: estações agora são totalmente dinâmicas — o admin pode criar/renomear/excluir vias
    // próprias além destas 6 padrão (📠 Estações de Impressão, em Editar Cardápio, e Configurações
    // → 📠 Impressoras por Estação). Qualquer chave nova aqui é preservada normalmente pelo
    // resto do sistema (ver readConfig/normalizeMenu/POST /api/config/POST /api/print abaixo).
    // v50: campo "active" — desativar uma estação (impressora quebrada, fechada por um tempo,
    // etc.) sem precisar excluir a via nem desmarcar ela de todos os itens. Enquanto active for
    // false, POST /api/print pula essa via de propósito (nem tenta imprimir, sem erro nenhum).
  },
  // v73.1: ordem/prioridade das vias de impressão escolhida pelo admin (▲/▼ em Configurações →
  // 📠 Impressoras por Estação). "caixa" não entra aqui — sempre é a primeira da lista.
  stationOrder: [],
  // v49: estação padrão usada quando um item do cardápio não tem NENHUMA estação marcada —
  // configurável em Configurações → 📠 Impressoras por Estação.
  defaultStation: 'cozinha',
  // ── Motivos de cancelamento/recusa (chips rápidos no painel) ──
  cancelReasons: ['Item em falta', 'Fora da área de entrega', 'Pedido duplicado', 'Cliente desistiu', 'Loja fechada no momento'],
  // ── Aparência do painel (tamanho de fonte por aba) ──
  uiFonts: { pedidos: 13, config: 13, clientes: 13, relatorios: 13 },
  // ── Paleta de cores do site do cliente ──
  theme: { primary: '#c9a84c', accent: '#c0392b', bg: '#0a0a0a' },
  // ── Slider de capa (imagens rotativas no topo do site) ──
  slides: [],
  // ── Taxa de entrega por distância ──
  feeMode: 'fixo',            // 'fixo' (taxa única) ou 'distancia' (calculada por km)
  storeLat: null, storeLng: null, // coordenadas do restaurante (preenchidas pelo painel)
  feeBaseKm: 2,                // km inclusos na taxa base
  feeBaseValue: 8,             // R$ da taxa até feeBaseKm
  feePerKm: 2.5,                // R$ por km excedente
  feeMaxKm: 12,                 // raio máximo de entrega (0 = sem limite)
  feeRound: 0.5,                 // arredonda a taxa para múltiplos disso
  // ── Taxa de entrega por CEP ou por Bairro (zonas com valor fixo cada) ──
  feeZonesCep: [],               // [{ prefix:'28890', label:'Costazul', fee:6 }, ...]
  feeZonesBairro: [],            // [{ bairro:'Costazul', fee:6 }, ...]
  feeZoneFallback: 'padrao',      // 'padrao' (usa cfg.fee se não achar a zona) ou 'bloqueado' (recusa o pedido)
  // ── Cupons de desconto (aplicados pelo cliente no checkout) ──
  coupons: [],                    // [{code, type:'percent'|'valor'|'frete_gratis', value, active, expiresAt, usageLimit, usedCount, minOrder}]
  // ── Popup premium de instalação do PWA (v71) — oferece um benefício (cupom já cadastrado
  // acima em cfg.coupons, ou um valor de bônus só informativo) pra quem instala o app ──
  installPromo: {
    enabled: true,
    type: 'cupom',                // 'cupom' (usa um código de cfg.coupons) ou 'bonus' (texto livre de crédito)
    cupomCode: '',                 // ex: 'PRIMEIRO10' — precisa existir em cfg.coupons pra funcionar no checkout
    bonusValue: '',                 // ex: '10,00' — só exibido no popup, não debita nada sozinho
    benefitCode: ''                 // código opcional copiado pro cliente ao clicar em Instalar (se vazio, usa cupomCode)
  },
  // ── Fidelidade — cliente acumula pontos a cada pedido ENTREGUE e troca por desconto ──
  loyalty: {
    enabled: true,
    pointsPerReal: 1,     // pontos ganhos por R$1 do total do pedido (arredondado pra baixo)
    redeemPoints: 100,     // quantos pontos formam 1 "bloco" de resgate
    redeemValue: 10,       // quanto vale em R$ de desconto cada bloco de redeemPoints
    minOrderToRedeem: 0    // pedido mínimo (R$) pra poder usar pontos, 0 = sem mínimo
  },
  // ── v73: Foto Provisória Global — uma única imagem usada automaticamente em TODO produto
  // que ainda não tem foto própria cadastrada. Assim que o produto ganha uma foto manual, ele
  // para de usar a provisória sozinho (a foto manual sempre tem prioridade, nunca é substituída).
  placeholderPhoto: {
    enabled: false,
    url: '',
    position: 'esquerda',   // 'esquerda' | 'direita' | 'acima'
    mode: 'cortar',         // 'preencher' | 'ajustar' | 'cortar'
    radius: 'medio'         // 'nenhum' | 'pequeno' | 'medio' | 'grande'
  },
  // ── v73: Badge Global — um selo (ex: "🔥 Mais vendido") aplicado automaticamente em todos os
  // produtos. Cada produto pode herdar essa configuração ou personalizar a própria (ver
  // item.badgeMode/item.badgeOverride no cardápio). ──
  globalBadge: {
    enabled: false,
    text: 'Mais vendido',
    icon: '🔥',
    bgColor: '#c0392b',
    textColor: '#ffffff',
    fontSize: 11,
    fontWeight: 700,
    opacity: 100,
    borderEnabled: false,
    borderColor: '#ffffff',
    borderRadius: 6,
    padding: 6,
    shadow: true,
    position: 'canto-superior-esquerdo' // acima-foto|abaixo-foto|sobre-foto|acima-nome|abaixo-nome|canto-superior-esquerdo|canto-superior-direito
  },
  // ── v73: valor pago ao motoboy por entrega — usado no Relatório de Taxas de Motoboy.
  // É separado da taxa de entrega cobrada do CLIENTE (cfg.fee/feeZonesBairro/feeZonesCep) porque
  // nem sempre o restaurante repassa o valor cheio pro entregador. ──
  courierPay: {
    mode: 'fixo',        // 'fixo' (mesmo valor pra toda entrega) ou 'bairro' (valor por bairro)
    fixedValue: 6,
    zones: []            // [{ bairro: 'Costazul', value: 6 }, ...]
  },
  // ── Número da senha/pedido (1 a 200, cíclico) ──
  nextTicketNumber: 1,
  // ── SMS (envio de promoções pros clientes cadastrados) — usa a API da Twilio.
  // Precisa de conta própria em twilio.com (pago, mas barato); sem isso configurado, o envio simplesmente falha com aviso claro.
  sms: { accountSid: '', authToken: '', fromNumber: '', fromWhatsApp: '', notifyWhatsApp: false },
  // ── IA de atendimento (v56) — responde dúvida do cliente automaticamente usando o cardápio como
  // contexto, e lê foto de nota fiscal/catálogo pra sugerir ingredientes em Custos & Ficha Técnica.
  // Usa a API da Anthropic (Claude) com a chave que o restaurante cadastra aqui. OPCIONAL: sem
  // isso configurado, os botões de IA simplesmente avisam que não está configurado, sem quebrar nada.
  // v91: badgesAutoAprovar — "☑ Permitir alteração automática de badges" do escopo da IA de
  // gestão. Só afeta sugestões de BADGE (tipo='badge'); novo produto e demais tipos continuam
  // sempre exigindo aprovação manual, sem exceção.
  // v98 — AI ROUTER: `modelo` continua sendo o modelo de TEXTO (compatibilidade — mesmo campo de
  // sempre); `modeloVisao` é novo e opcional, só usado quando o provedor for 'groq' e houver
  // imagem (padrão: qwen/qwen3.6-27b, ver IA_PROVEDORES). `fallbackAutomatico` liga a troca
  // automática de modelo/provedor quando o principal falha (429/limite/indisponível — nunca troca
  // por erro de conteúdo). `modoBasico` liga respostas locais simples no chat de atendimento
  // quando nenhuma IA está disponível, em vez de deixar o cliente sem nenhuma resposta.
  ia: { enabled: false, provider: 'groq', apiKey: '', modelo: '', modeloVisao: '', faq: [], badgesAutoAprovar: false, fallbackAutomatico: true, modoBasico: true },
  // ── Redes sociais (v56) — botão de pedido direto no Instagram/Facebook do cardápio online.
  // Deixe em branco pra não mostrar o botão correspondente.
  social: { instagram: '', facebook: '' },
  // ── Avaliações — frase que aparece pro cliente depois que ele confirma que recebeu o pedido ──
  reviewPrompt: 'O que você achou do seu pedido? Sua opinião ajuda muito a gente! 🍣',
  reviewPhrases: [
    'Comida deliciosa! 😋',
    'Entrega rápida! 🛵',
    'Atendimento excelente! ⭐',
    'Embalagem caprichada 📦',
    'Voltarei a pedir com certeza! 🙌'
  ],
  // ── Anúncios/promoções — aparecem pra QUALQUER pessoa que abrir o cardápio, sem precisar de conta ──
  announcements: [],  // [{id, title, message, active, expiresAt}]
  // ── Notificações Push (promoções/cupons/novidades direto no navegador do cliente, de graça) ──
  // As chaves VAPID são geradas sozinhas na primeira vez que o servidor liga (ver bootstrap abaixo)
  // e ficam salvas aqui — não apague nem troque manualmente, ou as inscrições já feitas param de funcionar.
  vapid: { publicKey: '', privateKeyJwk: null, subject: 'mailto:contato@shogatsu.com.br' },
  // ── Reserva de Mesas ──
  reservations: {
    enabled: true, maxPeoplePerTable: 12, note: '',
    // v126 — NOVO ("botão pra definir que dia/horário está liberado pra reservar"): até aqui
    // reserva usava o MESMO horário de funcionamento da loja (cfg.weekSchedule) sem nenhuma
    // forma de diferenciar — uma loja pode querer aceitar reserva só até 21h mesmo abrindo
    // até 23h (pra não reservar mesa perto do fechamento), ou não aceitar reserva às
    // segundas mesmo funcionando pra delivery. `useStoreSchedule: true` (padrão) mantém o
    // comportamento de sempre — usa cfg.weekSchedule normalmente, sem precisar configurar
    // nada a mais. Desligando, passa a usar o `schedule` próprio abaixo (mesmo formato do
    // weekSchedule — 7 posições, domingo=0).
    useStoreSchedule: true,
    schedule: [
      { open: true, openTime: '18:00', closeTime: '23:00' },
      { open: false, openTime: '18:00', closeTime: '23:00' },
      { open: true, openTime: '18:00', closeTime: '23:00' },
      { open: true, openTime: '18:00', closeTime: '23:00' },
      { open: true, openTime: '18:00', closeTime: '23:00' },
      { open: true, openTime: '18:00', closeTime: '23:00' },
      { open: true, openTime: '18:00', closeTime: '23:00' }
    ],
    // v126 — NOVO: datas específicas fechadas pra reserva (feriado, evento fechado, etc.),
    // mesmo em dias que normalmente aceitam — formato 'YYYY-MM-DD'.
    blockedDates: []
  },
  // ── Agendamento de Pedidos (cliente escolhe um horário futuro pra retirada/entrega) ──
  scheduling: { enabled: true, minMinutesAhead: 60, maxDaysAhead: 7 },
  // ── v47: Splash Screen Premium — sequência de fotos em tela cheia ao abrir o app, com
  // animação suave (zoom/fade/parallax), configurável pelo painel (Configurações → Splash). ──
  splash: { enabled: false, durationSeconds: 3, transition: 'zoom', photos: [] },
  // ── v67: Fundo do Chat (Chat Express) — igual ao "papel de parede" do WhatsApp, mas pra
  // conversa do chat de atendimento do cliente. `url` pode ser um upload próprio (/uploads/...)
  // ou uma das fotos prontas da galeria (/images/chat-backgrounds/...). `overlay` é a opacidade
  // (0 a 1) do escurecido aplicado por cima da foto pra manter o texto das mensagens legível.
  chatBackground: { enabled: false, url: '', name: '', size: 0, width: 0, height: 0, date: '', overlay: 0.45 },
  // v78: mesma ideia do fundo do Chat Express (cliente), só que pro chat interno do painel
  // (Mensagens → Conversas) — cada um pode ter sua própria foto de fundo, independente.
  adminChatBackground: { enabled: false, url: '', name: '', size: 0, width: 0, height: 0, date: '', overlay: 0.45 },
  // ── Cardápio do Rodízio Popular (página pública cardapio-rodizio-popular.html) — v39:
  // antes esses dados ficavam fixos dentro do próprio HTML; agora vêm daqui, editáveis pela
  // aba "🔗 QR Code & Links" do painel, sem precisar mexer em nenhum arquivo.
  rodizioPopular: {
    phrases: [
      'Sushi à vontade. Sabor sem limites.',
      'Aqui o rodízio é show — e o camarão é liberado.',
      'Cada peça, uma experiência. Cada mesa, um banquete.',
      'Temaki, sashimi, grelhados... e o refri é por nossa conta.',
      'Sabor japonês de verdade, no seu ritmo, sem pressa.'
    ],
    heroPhoto: '',
    priceGroups: [
      { label: 'Terça, Quarta e Quinta', cash: 'R$ 59,99', card: 'R$ 79,99' },
      { label: 'Sexta, Sábado e Domingo', cash: 'R$ 64,99', card: 'R$ 84,99' }
    ],
    priceNote: 'Valores válidos a partir das <b>18:30</b>.',
    highlights: [
      { icon: '🥤', label: 'Refrigerante Liberado' },
      { icon: '🥢', label: 'Temaki' },
      { icon: '🍤', label: 'Camarão ao Alho e Óleo' },
      { icon: '🍄', label: 'Shimeji' }
    ],
    gallery: [{ photo: '' }, { photo: '' }, { photo: '' }, { photo: '' }, { photo: '' }, { photo: '' }],
    categories: [
      { icon: '🍙', title: 'Hossomaki', items: ['Haddock Maki', 'Filadélfia', 'Kani Maki', 'Salmão Maki', 'Tartare Skin', 'Tekka Maki', 'Tartare de Salmão', 'Goiabada com Fruta do Dia', 'Camarão Grelhado', 'Tilápia com Geleia'] },
      { icon: '🍱', title: 'Uramakis', items: ['Salmão', 'Filadélfia Roll', 'Skin Roll', 'Atum', 'Califórnia', 'Haddock', 'Joy Salmão'] },
      { icon: '🍣', title: 'Sushis Diversos', items: ['Sushi Salmão', 'Sushi de Peixe Branco', 'Sushi Skin'] },
      { icon: '🥢', title: 'Temakis Tradicionais', items: ['Temaki Filadélfia', 'Temaki Hot Filadélfia'] },
      { icon: '✨', title: 'Especiais', items: ['Ceviche do Dia', 'Sunomono com Kani', 'Skin de Salmão com Cebolinha'] },
      { icon: '🍤', title: 'Fritos — Empanados', items: ['Peixe do Dia na Crosta de Ervas', 'Lula Milanesa (Dorê)', 'Frango Milanesa', 'Bolinho de Salmão', { name: 'Salmão Especial', sub: 'sob consulta' }, 'Frango Recheado Especial', 'Harumaki de Camarão', 'Harumaki de Frango', 'Harumaki de Legumes', 'Harumaki de Queijo e Presunto'] },
      { icon: '🔥', title: 'Grelhados', items: ['Lula ao Alho e Óleo', 'Camarão ao Alho e Óleo', 'Yakisoba Misto (Filé Mignon e Frango)', { name: 'Shimeji na Manteiga', sub: 'sob consulta' }, 'Filé Mignon Suíno Agridoce'] },
      { icon: '🍰', title: 'Sobremesas', items: ['Harumaki Romeu e Julieta', 'Harumaki Doce de Leite com Ameixa', 'Harumaki de Chocolate com Banana', 'Banana Empanada com Chocolate'] }
    ],
    address: 'Av. Gov. Roberto Silveira, 109 — Costa Azul, Rio das Ostras',
    whatsapp: '552227641333',
    instagram: 'shogatsurestaurante',
    deliveryUrl: '/',
    wasteNote: 'Taxa de desperdício: valor da peça do cardápio. Evite desperdício pra podermos manter nossa promoção e sempre atender melhor!',
    // v51: fontes/tamanhos ajustáveis pela aba de edição — sem isso, mudar a "cara" da página
    // exigia mexer direto no CSS do arquivo. accentColor troca a cor de destaque (preços,
    // ícones, bordas); headingFont/bodyFont trocam a família tipográfica; fontScale ajusta o
    // tamanho geral do texto (1 = padrão, 0.9 = menor, 1.15 = maior).
    theme: { headingFont: 'serif', bodyFont: 'sans-serif', accentColor: '#c9a24a', fontScale: 1 }
  }
};
const DEFAULT_MENU = require('./default-menu.json');

// ─── Bootstrap dos arquivos de dados ───
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ cfg: DEFAULT_CFG, menu: DEFAULT_MENU }, null, 2));
}
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '[]');
if (!fs.existsSync(RESERVATIONS_FILE)) fs.writeFileSync(RESERVATIONS_FILE, '[]');
if (!fs.existsSync(PUSH_SUBS_FILE)) fs.writeFileSync(PUSH_SUBS_FILE, '[]');
if (!fs.existsSync(ADMIN_PUSH_SUBS_FILE)) fs.writeFileSync(ADMIN_PUSH_SUBS_FILE, '[]');
if (!fs.existsSync(SCHEDULED_PUSH_FILE)) fs.writeFileSync(SCHEDULED_PUSH_FILE, '[]');
if (!fs.existsSync(COURIERS_FILE)) fs.writeFileSync(COURIERS_FILE, '[]');
if (!fs.existsSync(INGREDIENTES_FILE)) fs.writeFileSync(INGREDIENTES_FILE, '[]');
if (!fs.existsSync(FICHAS_TECNICAS_FILE)) fs.writeFileSync(FICHAS_TECNICAS_FILE, '[]');
if (!fs.existsSync(APROVACOES_IA_FILE)) fs.writeFileSync(APROVACOES_IA_FILE, '[]');
if (!fs.existsSync(CUSTOS_CONFIG_FILE)) fs.writeFileSync(CUSTOS_CONFIG_FILE, JSON.stringify({ diasParaDesatualizado: 21, margemPadrao: 65 }, null, 2));
if (!fs.existsSync(DELETE_LOG_FILE)) fs.writeFileSync(DELETE_LOG_FILE, '[]');
if (!fs.existsSync(CONTATOS_IMPORTADOS_FILE)) fs.writeFileSync(CONTATOS_IMPORTADOS_FILE, '[]');
if (!fs.existsSync(ATENDIMENTO_FILE)) fs.writeFileSync(ATENDIMENTO_FILE, '{}');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
if (!fs.existsSync(PRINT_LOG_FILE)) fs.writeFileSync(PRINT_LOG_FILE, '[]');
if (!fs.existsSync(IA_CACHE_FILE)) fs.writeFileSync(IA_CACHE_FILE, '{}'); // v98
if (!fs.existsSync(IA_LOG_FILE)) fs.writeFileSync(IA_LOG_FILE, '[]');     // v98

// Gera as chaves VAPID (necessárias pra notificação push) na primeira vez que o servidor liga,
// e salva no config.json — depois disso nunca mais muda (senão as inscrições dos clientes quebram).
function ensureVapidKeys() {
  try {
    const data = readJSON(CONFIG_FILE);
    if (!data.cfg.vapid || !data.cfg.vapid.publicKey) {
      const keys = webpush.generateVapidKeys();
      data.cfg.vapid = { publicKey: keys.publicKey, privateKeyJwk: keys.privateKeyJwk, subject: (data.cfg.vapid && data.cfg.vapid.subject) || DEFAULT_CFG.vapid.subject };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
      console.log('🔔 Chaves VAPID geradas (primeira execução) — notificação push já pode ser usada.');
    }
  } catch (e) { console.error('⚠️  Não consegui gerar as chaves VAPID:', e.message); }
}
ensureVapidKeys();

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJSON(file, data) {
  // v125 final: gravação atômica — evita deixar JSON pela metade se o processo cair durante a escrita.
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
  syncToSupabase(file, data); // fire-and-forget — nunca trava nem quebra a resposta ao usuário
}

// ═══════════════════════════════════════════════════════════
// SUPABASE — backup automático pra sobreviver a deploys no Render
// ═══════════════════════════════════════════════════════════
// O disco local (pasta data/) continua sendo usado pra tudo — é rápido e simples. O Supabase
// funciona como uma cópia de segurança: toda vez que orders.json/config.json/customers.json
// muda, mandamos uma cópia pra lá; e quando o servidor liga (ex: depois de um deploy que apagou
// o disco local), a gente PRIMEIRO tenta trazer de volta o que tiver salvo no Supabase antes de
// aceitar qualquer pedido novo.
// Configure em Environment no Render: SUPABASE_URL e SUPABASE_SERVICE_KEY (a "service_role key",
// não a "anon" — precisa de permissão de escrita). Sem essas duas variáveis, tudo funciona igual
// a antes, só sem o backup (o app nunca quebra por falta disso).
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'shogatsu_kv';
const FILE_TO_KEY = { [ORDERS_FILE]: 'orders', [CONFIG_FILE]: 'config', [CUSTOMERS_FILE]: 'customers', [RESERVATIONS_FILE]: 'reservations', [PUSH_SUBS_FILE]: 'push_subs', [ADMIN_PUSH_SUBS_FILE]: 'admin_push_subs', [SCHEDULED_PUSH_FILE]: 'scheduled_push', [COURIERS_FILE]: 'couriers', [DELETE_LOG_FILE]: 'delete_log', [PERMISSION_LOG_FILE]: 'permission_log', [INGREDIENTES_FILE]: 'ingredientes', [FICHAS_TECNICAS_FILE]: 'fichas_tecnicas', [CUSTOS_CONFIG_FILE]: 'custos_config', [SESSIONS_FILE]: 'sessions', [APROVACOES_IA_FILE]: 'aprovacoes_ia' };

function supabaseRequest(method, subpath, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return reject(new Error('Supabase não configurado'));
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(`${SUPABASE_URL}/rest/v1/${subpath}`);
    const req = https.request(u, {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); } catch (e) { resolve(null); }
        } else reject(new Error(`Supabase HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// v107 — REDUÇÃO DE BANDWIDTH: antes, TODO writeJSON reenviava o arquivo inteiro pro Supabase,
// mesmo quando o conteúdo era idêntico ao que já tinha sido mandado (ex: mesma config salva duas
// vezes, ou um campo que voltou ao valor anterior). Agora guardamos em memória o último payload
// enviado com sucesso por chave e pulamos o envio se for exatamente igual — sem nenhum atraso e
// sem mudar o que o disco local grava (isso continua instantâneo, igual antes). Reduz tráfego
// "Service-Initiated" sem tocar em nenhuma funcionalidade: se o conteúdo mudou de verdade, o
// envio acontece normalmente, do mesmo jeito de sempre.
const lastSyncedPayload = new Map(); // key (ex: "orders") -> JSON string do último envio bem-sucedido
function syncToSupabase(file, data) {
  const key = FILE_TO_KEY[file];
  if (!key || !SUPABASE_URL || !SUPABASE_KEY) return;
  const payloadStr = JSON.stringify(data);
  if (lastSyncedPayload.get(key) === payloadStr) return; // idêntico ao último enviado — nada novo pra sincronizar
  supabaseRequest('POST', `${SUPABASE_TABLE}?on_conflict=key`, { key, value: data, updated_at: new Date().toISOString() })
    .then(() => { lastSyncedPayload.set(key, payloadStr); })
    .catch(err => console.error(`⚠️  Falha ao sincronizar "${key}" com o Supabase:`, err.message));
}

// Roda uma vez, ao ligar o servidor: se tiver Supabase configurado, traz de volta o último
// estado salvo (útil logo depois de um deploy que apagou o disco local do Render).
async function restoreFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  console.log('☁️  Verificando backup no Supabase...');
  await Promise.allSettled(Object.entries(FILE_TO_KEY).map(async ([file, key]) => {
    try {
      const rows = await supabaseRequest('GET', `${SUPABASE_TABLE}?key=eq.${key}&select=value`);
      if (rows && rows[0] && rows[0].value !== undefined) {
        fs.writeFileSync(file, JSON.stringify(rows[0].value, null, 2));
        console.log(`   ✓ "${key}" restaurado do Supabase`);
      }
    } catch (err) {
      console.error(`   ⚠️  Não consegui restaurar "${key}" do Supabase:`, err.message);
    }
  }));
}

// v60 — BUG REAL INVESTIGADO ("fotos que não carregam/desaparecem"): a causa raiz é a mesma dos
// comentários acima — public/uploads/ mora no MESMO disco que o Render apaga a cada deploy (a
// menos que UPLOADS_DIR aponte pra um Disco Persistente configurado à parte). Diferente de
// orders/config/customers, as fotos NUNCA tinham backup nenhum — o registro (ex: foto do prato no
// cardápio) sobrevivia via Supabase, mas o ARQUIVO da foto em si sumia, e a imagem ficava
// quebrada/sumida no cardápio, no cadastro de motoboy, etc. Agora, se o Supabase estiver
// configurado, toda foto enviada por POST /api/upload também é guardada lá (em base64) e
// restaurada pra UPLOADS_DIR automaticamente ao ligar o servidor — sem precisar de Disco
// Persistente pago pra não perder fotos. Vídeos (Live Photo) ficam de fora desse backup (arquivo
// grande demais pra guardar como texto no banco com folga de sobra) — pra esses, o Disco
// Persistente do Render continua sendo a única forma garantida de não perder o arquivo.
function syncUploadToSupabase(filename, buffer, ext) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const key = 'upload_' + filename;
  supabaseRequest('POST', `${SUPABASE_TABLE}?on_conflict=key`, { key, value: { ext, b64: buffer.toString('base64') }, updated_at: new Date().toISOString() })
    .catch(err => console.error(`⚠️  Falha ao fazer backup da foto "${filename}" no Supabase:`, err.message));
}
// v107 — REDUÇÃO DE BANDWIDTH (causa raiz do consumo alto de "Service-Initiated"): antes, essa
// função baixava o CONTEÚDO (base64) de TODAS as fotos já enviadas de uma vez só — mesmo das que
// já existiam certinho em UPLOADS_DIR — e ela roda em TODO restart do processo (todo deploy, todo
// crash-restart, todo "acordar" de plano free/starter que dorme por inatividade). Com fotos de até
// 4MB (~5,3MB em base64) e dezenas delas cadastradas, cada restart baixava dezenas/centenas de MB
// do Supabase de novo, mesmo sem nenhuma foto nova. Agora o fluxo é em duas etapas: primeiro pede
// só os NOMES (select=key, sem o base64 pesado — consulta minúscula), compara com o que já existe
// em disco, e SÓ baixa o conteúdo (base64) de quem realmente falta. O resultado final é idêntico
// (depois de um deploy que realmente apagou o disco, TODAS as fotos continuam sendo restauradas —
// nenhuma foto deixa de ser recuperada), só que sem re-baixar o que já está lá.
async function restoreUploadsFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const rows = await supabaseRequest('GET', `${SUPABASE_TABLE}?key=ilike.upload_*&select=key`);
    const faltando = (rows || [])
      .map(r => String(r.key || '').replace(/^upload_/, ''))
      .filter(filename => filename && !fs.existsSync(path.join(UPLOADS_DIR, filename)));
    let restauradas = 0;
    for (const filename of faltando) {
      try {
        const linhas = await supabaseRequest('GET', `${SUPABASE_TABLE}?key=eq.${encodeURIComponent('upload_' + filename)}&select=value`);
        const row = linhas && linhas[0];
        const dest = path.join(UPLOADS_DIR, filename);
        if (!row || !row.value || !row.value.b64 || fs.existsSync(dest)) continue; // sem conteúdo salvo, ou já apareceu enquanto restaurava outras
        fs.writeFileSync(dest, Buffer.from(row.value.b64, 'base64'));
        restauradas++;
      } catch (e) { /* ignora essa foto e segue restaurando as outras */ }
    }
    if (restauradas) console.log(`   ✓ ${restauradas} foto(s) restaurada(s) do Supabase pra uploads/`);
  } catch (err) { console.error('   ⚠️  Não consegui restaurar fotos do Supabase:', err.message); }
}
// v67 — Fundo do Chat: lê largura/altura da imagem direto dos bytes (sem depender de nenhuma
// biblioteca externa — o projeto é 100% vanilla Node). Cobre PNG, JPEG e WEBP (os 3 formatos
// aceitos pelo upload). Se não conseguir entender o cabeçalho, devolve 0x0 sem quebrar o upload —
// largura/altura aqui são só informativas pro painel, não afetam a exibição (que usa cover).
function getImageDimensions(buffer, ext) {
  try {
    if (ext === 'png' && buffer.length >= 24 && buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xFF) { i++; continue; }
        const marker = buffer[i + 1];
        // SOF0..SOF15 (exceto DHT/JPG/DAC) carregam as dimensões reais do quadro
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
        const len = buffer.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
    if (ext === 'webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buffer.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3FFF, height: buffer.readUInt16LE(28) & 0x3FFF };
      if (fmt === 'VP8L') { const b = buffer.readUInt32LE(21); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
      if (fmt === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
  } catch (e) { /* cabeçalho fora do esperado — segue com 0x0 */ }
  return { width: 0, height: 0 };
}

// Usa sempre o horário de Brasília, independente de em qual fuso o servidor
// esteja rodando de verdade (isso evita o bug clássico de "abriu 3h errado"
// quando o servidor roda em UTC, como costuma acontecer em hospedagem na nuvem).
// Lida com horários que passam da meia-noite (ex: 18:00–02:00).
function isWithinSchedule(openTime, closeTime) {
  if (!openTime || !closeTime) return true;
  const nowStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const nowMin = toMinutes(nowStr), openMin = toMinutes(openTime), closeMin = toMinutes(closeTime);
  if (openMin === closeMin) return true; // aberto 24h
  if (openMin < closeMin) return nowMin >= openMin && nowMin < closeMin;
  return nowMin >= openMin || nowMin < closeMin; // passa da meia-noite
}

// Lê o config.json e preenche com os valores padrão quaisquer campos novos que
// ainda não existiam (ex: sites já em produção antes desta atualização) —
// sem precisar apagar ou resetar nada que o restaurante já configurou.
function readConfig() {
  let data = readJSON(CONFIG_FILE);
  // Blindagem: versões antigas tinham um bug em que alguns endpoints (geocode-by-cep,
  // geocode-store) gravavam o objeto de config "cru" no lugar de { cfg, menu }.
  // Se isso já aconteceu (arquivo local ou backup do Supabase corrompido dessa forma),
  // data.cfg viria undefined e derrubava o servidor inteiro. Aqui a gente detecta esse
  // formato antigo e se recupera sozinho, sem precisar mexer no arquivo na mão.
  if (!data || typeof data !== 'object') {
    data = { cfg: DEFAULT_CFG, menu: DEFAULT_MENU };
  } else if (!data.cfg) {
    data = { cfg: data, menu: DEFAULT_MENU };
  }
  const cfg = {
    ...DEFAULT_CFG,
    ...data.cfg,
    // v49 — BUG CORRIGIDO ("impressora não imprime" em vias novas): antes só as 4 chaves de
    // DEFAULT_CFG.stations sobreviviam a essa leitura — qualquer estação nova criada pelo admin
    // (ex: uma via customizada, ou mesmo "delivery"/"expedicao" adicionadas nesta versão) era
    // APAGADA sozinha no próximo carregamento, porque esse merge só olhava pras chaves padrão.
    // Agora a lista de chaves é a UNIÃO entre as padrão e as que já estão salvas — nenhuma
    // estação criada pelo admin some mais.
    stations: (() => {
      const saved = (data.cfg && data.cfg.stations) || {};
      const keys = new Set([...Object.keys(DEFAULT_CFG.stations), ...Object.keys(saved)]);
      const shape = { label: '', icon: '📠', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 15 };
      return Object.fromEntries([...keys].map(st => [st, {
        ...shape, label: st,
        ...(DEFAULT_CFG.stations[st] || {}),
        ...(saved[st] || {})
      }]));
    })(),
    labels: { ...DEFAULT_CFG.labels, ...(data.cfg.labels || {}) },
    uiFonts: { ...DEFAULT_CFG.uiFonts, ...(data.cfg.uiFonts || {}) },
    theme: { ...DEFAULT_CFG.theme, ...(data.cfg.theme || {}) },
    cancelReasons: data.cfg.cancelReasons || DEFAULT_CFG.cancelReasons,
    slides: data.cfg.slides || DEFAULT_CFG.slides,
    users: (Array.isArray(data.cfg.users) && data.cfg.users.length) ? data.cfg.users : DEFAULT_CFG.users,
    sms: { ...DEFAULT_CFG.sms, ...(data.cfg.sms || {}) },
    ia: { ...DEFAULT_CFG.ia, ...(data.cfg.ia || {}) },
    social: { ...DEFAULT_CFG.social, ...(data.cfg.social || {}) },
    schedule: { ...DEFAULT_CFG.schedule, ...(data.cfg.schedule || {}) },
    weekSchedule: Array.isArray(data.cfg.weekSchedule) && data.cfg.weekSchedule.length === 7
      ? DEFAULT_CFG.weekSchedule.map((d, i) => ({ ...d, ...(data.cfg.weekSchedule[i] || {}) }))
      : DEFAULT_CFG.weekSchedule,
    vapid: { ...DEFAULT_CFG.vapid, ...(data.cfg.vapid || {}) },
    reservations: {
      ...DEFAULT_CFG.reservations, ...(data.cfg.reservations || {}),
      // v126 — mesmo cuidado do weekSchedule acima: valida item a item (não deixa a tela
      // salvar um array incompleto/malformado e quebrar a validação de horário depois).
      schedule: (Array.isArray(data.cfg.reservations && data.cfg.reservations.schedule) && data.cfg.reservations.schedule.length === 7)
        ? DEFAULT_CFG.reservations.schedule.map((d, i) => ({ ...d, ...(data.cfg.reservations.schedule[i] || {}) }))
        : DEFAULT_CFG.reservations.schedule,
      blockedDates: Array.isArray(data.cfg.reservations && data.cfg.reservations.blockedDates)
        ? data.cfg.reservations.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200)
        : DEFAULT_CFG.reservations.blockedDates
    },
    scheduling: { ...DEFAULT_CFG.scheduling, ...(data.cfg.scheduling || {}) },
    rodizioPopular: { ...DEFAULT_CFG.rodizioPopular, ...(data.cfg.rodizioPopular || {}) },
    splash: { ...DEFAULT_CFG.splash, ...(data.cfg.splash || {}), photos: Array.isArray(data.cfg.splash && data.cfg.splash.photos) ? data.cfg.splash.photos : DEFAULT_CFG.splash.photos },
    chatBackground: { ...DEFAULT_CFG.chatBackground, ...(data.cfg.chatBackground || {}) },
    adminChatBackground: { ...DEFAULT_CFG.adminChatBackground, ...(data.cfg.adminChatBackground || {}) },
    // v73
    placeholderPhoto: { ...DEFAULT_CFG.placeholderPhoto, ...(data.cfg.placeholderPhoto || {}) },
    globalBadge: { ...DEFAULT_CFG.globalBadge, ...(data.cfg.globalBadge || {}) },
    courierPay: { ...DEFAULT_CFG.courierPay, ...(data.cfg.courierPay || {}), zones: Array.isArray(data.cfg.courierPay && data.cfg.courierPay.zones) ? data.cfg.courierPay.zones : DEFAULT_CFG.courierPay.zones },
    // v73.1: prioridade das impressoras/vias
    stationOrder: Array.isArray(data.cfg.stationOrder) ? data.cfg.stationOrder : DEFAULT_CFG.stationOrder
  };
  // Se a auto-programação de horário estiver ativada, o status aberto/fechado
  // passa a ser calculado sozinho a partir do horário configurado — o toggle
  // manual do painel deixa de valer enquanto isso estiver ligado.
  if (cfg.schedule && cfg.schedule.enabled) {
    cfg.open = isWithinSchedule(cfg.schedule.openTime, cfg.schedule.closeTime) ? 1 : 0;
  }
  return { cfg, menu: normalizeMenu(data.menu, Object.keys(cfg.stations), cfg.defaultStation) };
}

// ─── Sessões admin (em memória, espelhadas em disco + Supabase — v60) ───
const sessions = new Map(); // token -> { expiresAt, role, username }
function persistSessions() {
  // v60: grava o Map inteiro (só sessões ainda válidas) em disco a cada mudança, pra um
  // restart do processo (comum no Render) não derrubar quem já estava logado.
  const obj = {};
  for (const [tok, s] of sessions) { if (s.expiresAt >= Date.now()) obj[tok] = s; }
  try { writeJSON(SESSIONS_FILE, obj); } catch (e) { console.error('⚠️  Não consegui salvar sessions.json:', e.message); }
}
function loadSessionsFromDisk() {
  try {
    const obj = readJSON(SESSIONS_FILE);
    let restauradas = 0;
    for (const [tok, s] of Object.entries(obj || {})) {
      if (s && s.expiresAt > Date.now()) { sessions.set(tok, s); restauradas++; }
    }
    if (restauradas) console.log(`   ✓ ${restauradas} sessão(ões) de login restaurada(s) — ninguém precisa logar de novo à toa.`);
  } catch (e) { /* arquivo pode não existir ainda na primeira execução — tudo bem */ }
}
function newSession(role, username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + 1000 * 60 * 60 * 12, role: role || 'admin', username: username || 'admin' }); // 12h
  persistSessions();
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    if (s) { sessions.delete(token); persistSessions(); }
    return null;
  }
  return s;
}
function checkAuth(token) { return !!getSession(token); }
// master > admin > vendas — checa se a sessão tem o nível mínimo pedido. Papéis operacionais
// (caixa/cozinha/entrega, v107) ficam de propósito FORA dessa escada — não são "menos que
// vendas", são um tipo de acesso diferente (só o que a função precisa, sem hierarquia
// administrativa nenhuma) — por isso não entram no ROLE_RANK: qualquer requireRole(token,
// 'vendas'/'admin'/'master') já bloqueia esses três papéis automaticamente (rank padrão 0),
// e o que eles PODEM fazer é liberado à parte, função por função, abaixo.
const ROLE_RANK = { vendas: 1, admin: 2, master: 3 };
function requireRole(token, minRole) {
  const s = getSession(token);
  if (!s) return false;
  return (ROLE_RANK[s.role] || 0) >= (ROLE_RANK[minRole] || 99);
}
const OPERATIONAL_ROLES = ['caixa', 'cozinha', 'entrega'];
const ALL_ROLES = ['master', 'admin', 'vendas', ...OPERATIONAL_ROLES];
// v107 — SISTEMA DE PERMISSÕES: quem pode mudar um pedido de qual status pra qual. master,
// admin e vendas mantêm o comportamento de sempre (podem tudo em pedidos — nunca tiveram
// restrição nenhuma aqui, e mudar isso agora quebraria o uso normal da loja). Os 3 papéis
// operacionais novos só podem fazer exatamente a transição da função deles — verificado aqui
// no backend, nunca só na interface (o painel também esconde os botões que a função não usa,
// mas quem manda é este check; ver "não confiar apenas no frontend" no pedido de auditoria).
// v107 — SISTEMA DE PERMISSÕES: quem pode mudar um pedido de qual status pra qual. Evoluído na
// v109 pra consultar hasPermission() em vez de olhar só o "rank" do papel — assim o Master pode
// customizar isso usuário por usuário (item 20/21 do escopo: dois "caixa" podem ter permissões
// diferentes). QUEM NÃO TEM UMA PERMISSÃO CUSTOMIZADA fica exatamente como sempre foi (nenhum
// usuário existente perde acesso com esta atualização) — ver DEFAULT_PERMISSION_TEMPLATES acima.
function canChangeOrderStatus(session, fromStatus, toStatus) {
  if (!session) return false;
  if (session.role === 'master') return true;
  if (!hasPermission(session, 'pedidos', 'alterarStatus')) return false;
  if (toStatus === 'cancelado') return hasPermission(session, 'pedidos', 'cancelar');
  // Usuário SEM override de permissão (cfg.users[i].permissions não configurado pra "pedidos"):
  // mantém a régua específica por função que sempre existiu, transição por transição — pra não
  // mudar o comportamento de quem já opera assim há tempos.
  const user = findUserBySession(session);
  const hasCustomPedidos = !!(user && user.permissions && user.permissions.pedidos);
  if (!hasCustomPedidos) {
    if (ROLE_RANK[session.role]) return true; // master/admin/vendas — sem restrição, como sempre
    if (session.role === 'cozinha') {
      return (fromStatus === 'novo' && toStatus === 'preparando') || (fromStatus === 'preparando' && toStatus === 'saiu');
    }
    if (session.role === 'entrega') {
      return fromStatus === 'saiu' && toStatus === 'entregue';
    }
    if (session.role === 'caixa') {
      return ['preparando', 'saiu', 'entregue', 'cancelado'].includes(toStatus);
    }
    return false;
  }
  // Usuário COM permissões customizadas pelo Master pra "pedidos": já passou no check geral de
  // alterarStatus/cancelar acima — aqui é livre pra qualquer transição que não seja cancelamento
  // (o Master decidiu dar acesso a "Alterar status" sem granularidade de transição individual;
  // é a mesma simplicidade que a caixa de seleção do painel oferece).
  return true;
}

// ═══════════════════════════════════════════════════════════
// v109 — SISTEMA DE PERMISSÕES GRANULARES (Admin Master decide o que cada login pode fazer)
// ═══════════════════════════════════════════════════════════
// Catálogo fixo de categorias/ações que existem no sistema — é a partir daqui que o painel
// desenha as caixinhas de seleção (GET /api/admin/permission-catalog) e é contra ESTA lista que
// o backend valida qualquer alteração de permissão (não dá pra inventar uma chave nova só
// mexendo no JSON/localStorage). "role" aqui serve só de ORGANIZAÇÃO/modelo inicial — a permissão
// real de cada usuário fica em cfg.users[i].permissions, que o MASTER pode customizar campo a
// campo, mesmo pra dois usuários com a mesma função (ver pedido, item 20/21 do escopo).
const PERMISSION_CATALOG = {
  pedidos: { label: '📦 Pedidos', actions: {
    ver: 'Ver pedidos', criar: 'Criar pedidos', editar: 'Editar pedidos', cancelar: 'Cancelar pedidos',
    reabrir: 'Reabrir pedidos', alterarStatus: 'Alterar status', imprimir: 'Imprimir pedidos',
    historico: 'Visualizar histórico'
  }},
  cardapio: { label: '🍣 Cardápio', actions: {
    ver: 'Ver cardápio', criarProduto: 'Criar produto', editarProduto: 'Editar produto',
    excluirProduto: 'Excluir produto', criarCategoria: 'Criar categoria', editarCategoria: 'Editar categoria',
    excluirCategoria: 'Excluir categoria', alterarPrecos: 'Alterar preços', gerenciarGrupos: 'Gerenciar grupos/complementos'
  }},
  clientes: { label: '👥 Clientes', actions: {
    ver: 'Ver clientes', criar: 'Criar clientes', editar: 'Editar clientes', excluir: 'Excluir clientes',
    verHistorico: 'Ver histórico de pedidos'
  }},
  alertas: { label: '🔔 Alertas', actions: {
    ver: 'Ver alertas', configurar: 'Configurar alertas', escolherSons: 'Escolher sons',
    alterarVolume: 'Alterar volume', configurarAtraso: 'Configurar alerta de atraso',
    ativarDesativar: 'Ativar/desativar alertas'
  }},
  dispositivos: { label: '📱 Dispositivos', actions: {
    ver: 'Ver dispositivos', conectarCelular: 'Conectar celular', desconectarCelular: 'Desconectar celular',
    gerenciar: 'Gerenciar dispositivos', configurarAlertasCelular: 'Configurar alertas do celular'
  }},
  usuarios: { label: '👤 Usuários', actions: {
    ver: 'Ver usuários', criar: 'Criar usuários', editar: 'Editar usuários', desativar: 'Desativar usuários',
    alterarSenhas: 'Alterar senhas', criarFuncoes: 'Criar funções', editarFuncoes: 'Editar funções',
    gerenciarPermissoes: 'Gerenciar permissões'
  }},
  relatorios: { label: '📊 Relatórios', actions: {
    ver: 'Ver relatórios', exportar: 'Exportar relatórios', financeiros: 'Relatórios financeiros',
    pedidos: 'Relatórios de pedidos'
  }},
  notificacoes: { label: '📢 Notificações', actions: {
    criar: 'Criar notificações', editar: 'Editar notificações', enviar: 'Enviar notificações',
    gerenciarInscritos: 'Gerenciar inscritos'
  }},
  restaurante: { label: '🏪 Restaurante', actions: {
    verConfig: 'Ver configuração', editarInformacoes: 'Editar informações', editarHorarios: 'Editar horários',
    configurarEntrega: 'Configurar entrega', configurarSetores: 'Configurar setores', configurarImpressoras: 'Configurar impressoras'
  }},
  sistema: { label: '⚙️ Sistema', actions: {
    configuracoesGerais: 'Configurações gerais', logs: 'Logs', configuracoesAvancadas: 'Configurações avançadas'
  }}
};
// Gera um template "tudo true" ou "tudo false" a partir do catálogo — usado tanto pros
// padrões por função quanto pra validar/limpar o que chega de fora em PATCH .../permissions
// (nunca aceitamos uma chave que não exista no catálogo, nem categoria/ação inventada).
function fullPermTemplate(value) {
  const out = {};
  for (const cat of Object.keys(PERMISSION_CATALOG)) {
    out[cat] = {};
    for (const act of Object.keys(PERMISSION_CATALOG[cat].actions)) out[cat][act] = value;
  }
  return out;
}
// Padrão por FUNÇÃO — é só o que cada função recebe quando o Master NÃO customizou nada pra
// aquele usuário específico (comportamento de sempre, pra ninguém que já usa o sistema hoje
// perder acesso de uma hora pra outra). O Master pode sobrescrever qualquer uma dessas caixinhas
// por usuário em Usuários → 🔐 Configurar Permissões — a partir daí, o valor customizado manda,
// não o padrão da função.
const DEFAULT_PERMISSION_TEMPLATES = {
  admin: fullPermTemplate(true), // admin sempre teve acesso a tudo que não é exclusivo de master
  vendas: (() => {
    const t = fullPermTemplate(false);
    Object.keys(t.pedidos).forEach(k => { t.pedidos[k] = true; }); // vendas sempre pôde mexer em pedido à vontade
    t.clientes.ver = true; // /api/admin/customer-lookup já liberava pra vendas
    return t;
  })(),
  caixa: (() => {
    const t = fullPermTemplate(false);
    Object.assign(t.pedidos, { ver: true, criar: true, imprimir: true, historico: true, alterarStatus: true, cancelar: true });
    return t;
  })(),
  cozinha: (() => {
    const t = fullPermTemplate(false);
    Object.assign(t.pedidos, { ver: true, alterarStatus: true, imprimir: true });
    return t;
  })(),
  entrega: (() => {
    const t = fullPermTemplate(false);
    Object.assign(t.pedidos, { ver: true, alterarStatus: true });
    return t;
  })(),
  _default: fullPermTemplate(false) // função desconhecida/personalizada sem nada configurado: nega tudo (seguro por padrão)
};
// Devolve o usuário completo (cfg.users[i]) pela sessão — é daqui que hasPermission() lê o
// override individual, se existir.
function findUserBySession(session) {
  if (!session) return null;
  const { cfg } = readConfig();
  return (cfg.users || []).find(u => String(u.username || '').toLowerCase() === String(session.username || '').toLowerCase()) || null;
}
// hasPermission(): master NUNCA passa por aqui (é superusuário por definição, item 18 do
// escopo — não existe caixinha que tire acesso do master). Pra qualquer outro papel: se o
// usuário tem uma permissão CUSTOMIZADA pelo Master pra essa categoria/ação específica, ela
// manda; senão, cai no padrão da função (DEFAULT_PERMISSION_TEMPLATES). Como isso é lido do
// arquivo a cada chamada (nunca fica "gravado" no token/sessão), uma alteração de permissão
// feita pelo Master vale JÁ NA PRÓXIMA REQUISIÇÃO daquele usuário — sem precisar deslogar
// ninguém (item 24 do escopo).
function hasPermission(session, category, action) {
  if (!session) return false;
  if (session.role === 'master') return true;
  if (!PERMISSION_CATALOG[category] || !PERMISSION_CATALOG[category].actions[action]) return false; // categoria/ação inexistente
  const user = findUserBySession(session);
  if (user && user.active === false) return false; // usuário desativado nunca tem permissão nenhuma
  if (user && user.permissions && user.permissions[category] && Object.prototype.hasOwnProperty.call(user.permissions[category], action)) {
    return !!user.permissions[category][action];
  }
  const template = DEFAULT_PERMISSION_TEMPLATES[session.role] || DEFAULT_PERMISSION_TEMPLATES._default;
  return !!(template[category] && template[category][action]);
}
function requirePermission(token, category, action) {
  return hasPermission(getSession(token), category, action);
}
// Devolve o conjunto de permissões EFETIVAS de uma sessão (customizada + padrão da função,
// já resolvidas) — mandado pro frontend no login pra ele saber o que mostrar/esconder sem
// precisar reimplementar essa lógica em JS (a decisão de verdade continua sendo sempre
// re-checada no backend em cada rota; isso aqui é só pra experiência da interface).
function effectivePermissions(session) {
  if (!session) return fullPermTemplate(false);
  if (session.role === 'master') return fullPermTemplate(true);
  const out = {};
  for (const cat of Object.keys(PERMISSION_CATALOG)) {
    out[cat] = {};
    for (const act of Object.keys(PERMISSION_CATALOG[cat].actions)) out[cat][act] = hasPermission(session, cat, act);
  }
  return out;
}
// ── Gerenciamento de USUÁRIOS: quem pode mexer em quem ──
// Regra do item 18/25/30: usuário comum NUNCA pode virar master, alterar o master, conceder
// permissão que não possui, ou se autoconceder algo. Só o próprio master é 100% livre aqui.
function canManageUsers(session, action) {
  if (!session) return false;
  if (session.role === 'master') return true;
  return hasPermission(session, 'usuarios', action || 'ver');
}
// targetUser = usuário que está sendo criado/editado; actingSession = quem está fazendo a ação.
// Retorna null se pode prosseguir, ou uma string com o motivo do bloqueio.
function guardUserMutation(actingSession, targetUser, proposedRole, proposedPermissions) {
  if (actingSession.role === 'master') return null; // master pode tudo, sem exceção
  if (targetUser && targetUser.role === 'master') return 'Só o usuário master pode alterar outro master.';
  if (proposedRole === 'master') return 'Só o usuário master pode conceder o nível master.';
  if (String(targetUser && targetUser.username || '').toLowerCase() === String(actingSession.username || '').toLowerCase()) {
    return 'Você não pode alterar suas próprias permissões.';
  }
  // Ninguém pode conceder a outro uma permissão que ELE MESMO não tem (item 25/31: "nenhum
  // usuário pode conceder a si mesmo ou a terceiros uma permissão que não possui").
  if (proposedPermissions) {
    for (const cat of Object.keys(PERMISSION_CATALOG)) {
      for (const act of Object.keys(PERMISSION_CATALOG[cat].actions)) {
        const wants = proposedPermissions[cat] && proposedPermissions[cat][act];
        if (wants && !hasPermission(actingSession, cat, act)) {
          return `Você não pode conceder a permissão "${PERMISSION_CATALOG[cat].actions[act]}" (${PERMISSION_CATALOG[cat].label}) porque você mesmo não tem essa permissão.`;
        }
      }
    }
  }
  return null;
}
// Sanitiza um objeto de permissões vindo de fora: só aceita as chaves que existem de verdade
// no catálogo, forçando tudo o mais pra boolean — nunca deixa passar campo desconhecido.
function sanitizePermissions(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const cat of Object.keys(PERMISSION_CATALOG)) {
    if (!input[cat] || typeof input[cat] !== 'object') continue;
    out[cat] = {};
    for (const act of Object.keys(PERMISSION_CATALOG[cat].actions)) {
      if (Object.prototype.hasOwnProperty.call(input[cat], act)) out[cat][act] = !!input[cat][act];
    }
  }
  return out;
}
// ── Histórico de alterações de permissão (item 29) — nunca grava senha, só quem/o quê/quando ──
function logPermissionChange(actorUsername, targetUsername, changes) {
  try {
    const log = readJSON(PERMISSION_LOG_FILE);
    log.unshift({ id: 'permlog_' + Date.now().toString(36), actor: actorUsername, target: targetUsername, changes, at: new Date().toISOString() });
    writeJSON(PERMISSION_LOG_FILE, log.slice(0, 1000));
  } catch (e) { /* nunca derruba a requisição principal por causa do log */ }
}
// Compara duas permissões (antes/depois) e devolve só o que mudou de verdade, em texto —
// usado pelo histórico (item 29: "Removeu: X / Adicionou: Y").
function diffPermissions(before, after) {
  const added = [], removed = [];
  for (const cat of Object.keys(PERMISSION_CATALOG)) {
    for (const act of Object.keys(PERMISSION_CATALOG[cat].actions)) {
      const b = !!(before && before[cat] && before[cat][act]);
      const a = !!(after && after[cat] && after[cat][act]);
      if (a && !b) added.push(`${PERMISSION_CATALOG[cat].label} · ${PERMISSION_CATALOG[cat].actions[act]}`);
      if (b && !a) removed.push(`${PERMISSION_CATALOG[cat].label} · ${PERMISSION_CATALOG[cat].actions[act]}`);
    }
  }
  return { added, removed };
}
// ── POST /api/config: endpoint único que salva cardápio + config da loja juntos (histórico do
// projeto). Pra não travar em quem só tem permissão parcial (ex: só "editar horários", sem
// poder mexer no cardápio), a checagem olha quais campos vieram no corpo da requisição e exige
// só a permissão correspondente àquele pedaço — se o usuário mandar campos de mais de uma
// categoria, precisa ter permissão pra CADA uma delas que aparece no corpo.
function configWritePermissionCheck(session, body) {
  if (!session) return 'unauthorized';
  if (session.role === 'master') return null;
  const c = body.cfg || {};
  const need = [];
  if (body.menu !== undefined || body.categories !== undefined) {
    const any = ['criarProduto', 'editarProduto', 'excluirProduto', 'criarCategoria', 'editarCategoria', 'excluirCategoria', 'alterarPrecos']
      .some(act => hasPermission(session, 'cardapio', act));
    if (!any) need.push('Cardápio');
  }
  if (c.lateAlert !== undefined || c.newOrderRing !== undefined || c.sound !== undefined || c.customerAlertSound !== undefined) {
    if (!hasPermission(session, 'alertas', 'configurar')) need.push('Alertas');
  }
  if (c.fee !== undefined || c.deliveryMode !== undefined || c.deliveryRadius !== undefined || c.deliveryZones !== undefined) {
    if (!hasPermission(session, 'restaurante', 'configurarEntrega')) need.push('Entrega');
  }
  if (c.stations !== undefined || c.printSize !== undefined || c.printFont !== undefined) {
    if (!hasPermission(session, 'restaurante', 'configurarImpressoras')) need.push('Impressoras');
  }
  if (c.schedule !== undefined || c.weekSchedule !== undefined || c.hours !== undefined) {
    if (!hasPermission(session, 'restaurante', 'editarHorarios')) need.push('Horários');
  }
  const genericFields = ['whats', 'storePhone', 'name', 'addr', 'days', 'logoUrl', 'min', 'time', 'timeRetirada'];
  if (genericFields.some(f => c[f] !== undefined)) {
    if (!hasPermission(session, 'restaurante', 'editarInformacoes')) need.push('Informações da loja');
  }
  return need.length ? `Seu usuário não tem permissão pra alterar: ${need.join(', ')}.` : null;
}


// Mantém só dígitos no telefone, pra "22999991234" e "(22) 99999-1234" serem o mesmo cliente.
function normalizePhone(phone) { return String(phone || '').replace(/\D/g, ''); }

function hashPin(phone, pin) {
  return crypto.createHash('sha256').update(normalizePhone(phone) + ':' + String(pin) + ':shogatsu-salt').digest('hex');
}

// v106 — BUG DE SEGURANÇA CORRIGIDO: senha dos usuários do painel (/api/admin/users) era
// gravada em `config.json` em TEXTO PURO (campo `password`). Quem tivesse acesso de leitura ao
// arquivo (backup, export, Supabase) via a senha de qualquer usuário direto. Os PINs de cliente
// já eram hasheados (hashPin, acima) — os logins do painel não. Corrigido pra usar hash
// (sha256 + salt fixo do app, mesmo padrão do hashPin) num novo campo `passwordHash`; contas
// antigas que ainda só têm `password` em texto puro são migradas automaticamente pro hash no
// primeiro login que der certo (silencioso, sem pedir nada de novo pro usuário).
function hashUserPassword(username, password) {
  return crypto.createHash('sha256').update(String(username || '').toLowerCase() + ':' + String(password) + ':shogatsu-user-salt').digest('hex');
}
function verifyUserPassword(user, password) {
  if (user.passwordHash) return user.passwordHash === hashUserPassword(user.username, password);
  // conta antiga, ainda sem hash — compara texto puro (só existe em bases já em produção
  // antes desta correção; some assim que alguém logar com sucesso, ver POST /api/login)
  return !!user.password && password === user.password;
}

function findCustomer(customers, phone) {
  const p = normalizePhone(phone);
  return customers.find(c => c.phone === p);
}

// Calcula quantos pedidos e o último pedido de um cliente, direto do orders.json
// (evita manter dois lugares com a mesma contagem fora de sincronia).
function customerStats(phone, orders) {
  const p = normalizePhone(phone);
  const mine = orders.filter(o => normalizePhone(o.phone) === p && o.status !== 'cancelado');
  return {
    orderCount: mine.length,
    lastOrderAt: mine.length ? mine[0].createdAt : null // orders.json fica sempre com o mais novo primeiro (unshift)
  };
}

// Saldo de pontos de fidelidade: soma o que foi GANHO em pedidos já entregues menos o que
// já foi GASTO em resgates (contando só pedidos não-cancelados, pra pedido cancelado devolver
// os pontos usados nele automaticamente). Calculado ao vivo — não existe um "contador" salvo em
// lugar nenhum, então nunca fica dessincronizado do histórico real de pedidos.
function loyaltyBalance(phone, orders, cfg) {
  const p = normalizePhone(phone);
  const mine = orders.filter(o => normalizePhone(o.phone) === p && o.status !== 'cancelado');
  const earned = mine.filter(o => o.status === 'entregue').reduce((s, o) => s + (Number(o.pointsEarned) || 0), 0);
  const redeemed = mine.reduce((s, o) => s + (Number(o.pointsRedeemed) || 0), 0);
  return { earned, redeemed, balance: Math.max(0, earned - redeemed) };
}

// ─── Clientes conectados via SSE (painel da cozinha) ───
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
}
// v82: rastreio de Agentes Locais de Impressão conectados — criado pra responder de vez a
// "impressão automática não funciona nem manual, nem no teste": antes disso era impossível o
// admin saber, só olhando o painel, se o print-agent.js sequer estava rodando/conectado no
// computador da loja — a única forma de descobrir era abrir o print-agent.log no computador
// físico. Agora o próprio agente avisa o servidor (POST /api/print-agent/announce, logo após
// logar e de novo a cada ~45s como "sinal de vida") e o painel mostra um aviso ✅/❌ bem visível
// em Central de Impressão. Guardado só em memória (não precisa persistir): cada entrada expira
// sozinha (ver PRINT_AGENT_TTL_MS) se o agente cair sem avisar (queda de luz, processo morto).
// v95 — build mais recente do print-agent.js distribuído junto com ESTE server.js. Usado só
// pra COMPARAR com o build que cada Agente Local conectado informa (ver /api/print-agent/announce
// e /api/print-agent/status) e avisar no painel quando algum agente está rodando código velho —
// o processo do agente é persistente (Tarefa Agendada do Windows) e NÃO recarrega sozinho
// quando os arquivos do sistema são atualizados; precisa de REINICIAR-AGENTE.bat. Atualizar esse
// valor sempre que print-agent.js mudar de verdade (não precisa mudar em toda alteração de
// server.js — só quando o AGENT_BUILD de lá também mudar).
const CURRENT_AGENT_BUILD = 'v125-part2';
const printAgents = new Map(); // agentId -> { label, stations, printers, build, lastSeen }
const PRINT_AGENT_TTL_MS = 90 * 1000; // sem novo aviso em 90s, considera o agente offline
function getOnlinePrintAgents() {
  const now = Date.now();
  for (const [id, a] of printAgents) { if (now - a.lastSeen > PRINT_AGENT_TTL_MS) printAgents.delete(id); }
  return [...printAgents.values()];
}
// v85: mesmo rastreio de "sinal de vida" acima, mas pro método "🖥 Navegador" — até aqui, um
// computador marcado como "🖥️ Terminal de Impressão" (Configurações → Central de Impressão)
// guardava isso só no PRÓPRIO localStorage, sem avisar o servidor. Resultado: uma via em modo
// Navegador podia ficar sem NENHUM terminal marcado de verdade (ex.: computador do Sushibar
// nunca teve a caixinha marcada, ou o painel ficou fechado) e ninguém no admin descobria —
// os pedidos só ficavam "sem imprimir" silenciosamente. Agora cada painel marcado como
// terminal avisa o servidor a cada ~45s (ver DEVICE_SESSION_ID/updatePrintTerminalHeartbeat no
// painel.html) e o admin vê "0 terminais conectados" na Central de Impressão.
const printTerminals = new Map(); // terminalId -> { lastSeen }
const PRINT_TERMINAL_TTL_MS = 90 * 1000;
function getOnlinePrintTerminalsCount() {
  const now = Date.now();
  for (const [id, t] of printTerminals) { if (now - t.lastSeen > PRINT_TERMINAL_TTL_MS) printTerminals.delete(id); }
  return printTerminals.size;
}

// v90: Estação Ativa de Impressão — só o computador com o PAINEL aberto e conectado (mandando
// heartbeat) pode autorizar impressão. Criado pra evitar que 2 computadores imprimam o mesmo
// pedido ao mesmo tempo quando existe mais de um Painel/Agente Local instalado (ex.: PC
// principal + PC reserva, ambos ligados ao mesmo tempo). Guardado só em memória, mesmo espírito
// de printAgents/printTerminals acima: cada Painel manda um stationId próprio (gerado e
// persistido no localStorage do navegador, ver getOrCreateStationId() em painel.html) e
// reivindica a estação ativa ao abrir (POST /api/print-station/register) — o mais recente a
// abrir sempre assume, a estação anterior perde autorização na hora. Enquanto o Painel
// continuar mandando heartbeat (POST /api/print-station/heartbeat a cada ~15s), continua sendo
// o único autorizado; se parar (painel fechado, aba trocada, conexão caiu) e passar
// ACTIVE_STATION_TIMEOUT_MS sem sinal, qualquer outro Painel aberto assume sozinho no próximo
// heartbeat dele — sem precisar reabrir nada. O Agente Local (print-agent/print-agent.js)
// consulta GET /api/print-station/status periodicamente pra saber se ELE está na estação ativa
// antes de imprimir (comparando com o "stationId" opcional do próprio config.json).
const ACTIVE_STATION_TIMEOUT_MS = 25 * 1000; // sem heartbeat por 25s = estação considerada offline
let activeStation = null; // { stationId, label, lastSeen }
const knownStations = new Map(); // stationId -> { label, lastSeen } — só pra diagnóstico
function isActiveStationAlive() {
  return !!activeStation && (Date.now() - activeStation.lastSeen) < ACTIVE_STATION_TIMEOUT_MS;
}
function claimActiveStation(stationId, label) {
  // v100: trim defensivo — um espaço a mais/menos (copy-paste do config.json do Agente Local,
  // ou digitado à mão no Painel via renameStationId()) não pode quebrar a comparação exata feita
  // em isStationAuthorized()/isAuthorizedToPrint().
  activeStation = { stationId: String(stationId).trim(), label: String(label || stationId || '').slice(0, 60), lastSeen: Date.now() };
  knownStations.set(activeStation.stationId, { label: activeStation.label, lastSeen: activeStation.lastSeen });
  broadcast('active-station-changed', { activeStationId: activeStation.stationId, activeLabel: activeStation.label });
  return activeStation;
}
// v90: usado pelo POST /api/print (impressão disparada por um Painel) pra decidir se PODE
// imprimir. Enquanto NENHUM Painel nunca tiver mandado heartbeat (activeStation ainda null —
// ex.: sistema recém-atualizado, ou loja com um só Painel que nunca chegou a rodar 2 ao mesmo
// tempo), libera geral (modo compatível/legado), pra não quebrar a impressão automática de
// quem já usava o sistema antes dessa trava existir. Um stationId vazio (Painel desatualizado,
// que ainda não manda esse campo) também não bloqueia — mesmo motivo.
function isStationAuthorized(stationId) {
  if (!isActiveStationAlive()) return true;
  if (!stationId || !String(stationId).trim()) return true;
  return String(stationId).trim() === activeStation.stationId;
}

// ─── Clientes conectados via SSE no SITE DO CLIENTE (só avisa "cardápio mudou",
// nunca manda dados de pedido/cliente — canal público, sem autenticação) ───
const publicSseClients = new Set();
function publicBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of publicSseClients) { try { res.write(payload); } catch (e) {} }
}

// ─── Geolocalização / taxa por distância ───
// Faz um GET https e retorna o corpo já parseado como JSON, com timeout.
function httpsGetJSON(urlStr, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

// CEP (só dígitos) → endereço aproximado via ViaCEP (gratuito, sem chave)
async function lookupCEP(cep) {
  const clean = String(cep || '').replace(/\D/g, '');
  if (clean.length !== 8) return null;
  const data = await httpsGetJSON(`https://viacep.com.br/ws/${clean}/json/`);
  if (!data || data.erro) return null;
  return { street: data.logradouro || '', hood: data.bairro || '', city: data.localidade || '', uf: data.uf || '' };
}

// Endereço em texto → { lat, lng } via Nominatim/OpenStreetMap (gratuito, sem chave).
// IPs de servidores na nuvem (Render, etc.) costumam ser compartilhados por muitos outros
// projetos batendo no mesmo serviço gratuito, então de vez em quando ele responde "429 - limite
// de requisições" mesmo sem essa loja ter abusado. Por isso, tenta de novo uma vez, esperando
// um pouco (respeitando a política de no máx. 1 requisição/segundo do próprio Nominatim).
async function geocodeAddress(addressText, isRetry) {
  const q = encodeURIComponent(addressText);
  try {
    const data = await httpsGetJSON(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${q}`,
      { 'User-Agent': 'ShogatsuPedidosOnline/1.0 (contato via painel do restaurante)' },
      10000
    );
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
  } catch (e) {
    if (!isRetry && /HTTP 429/.test(e.message)) {
      // Nominatim bloqueou — tenta um provedor DIFERENTE (Photon, também gratuito e sem chave,
      // mas com infraestrutura própria, então não sofre do mesmo bloqueio de IP compartilhado).
      try {
        const alt = await httpsGetJSON(
          `https://photon.komoot.io/api/?limit=1&q=${q}`,
          { 'User-Agent': 'ShogatsuPedidosOnline/1.0 (contato via painel do restaurante)' },
          10000
        );
        const feat = alt && alt.features && alt.features[0];
        if (feat && feat.geometry && feat.geometry.coordinates) {
          const [lng, lat] = feat.geometry.coordinates;
          const p = feat.properties || {};
          const label = [p.name, p.street, p.city, p.state].filter(Boolean).join(', ');
          return { lat, lng, label };
        }
      } catch (e2) { /* os dois provedores falharam — segue pro erro normal abaixo */ }
    }
    throw e;
  }
}

// Geocodificação reversa: lat/lng (do GPS do navegador do cliente) -> endereço.
// Usada pelo botão "usar minha localização" no checkout, pra preencher CEP/rua/bairro sozinho.
async function reverseGeocode(lat, lng) {
  const data = await httpsGetJSON(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`,
    { 'User-Agent': 'ShogatsuPedidosOnline/1.0 (contato via painel do restaurante)' }
  );
  if (!data || !data.address) return null;
  const a = data.address;
  return {
    cep: (a.postcode || '').replace(/\D/g, ''),
    street: a.road || '',
    number: a.house_number || '',
    hood: a.suburb || a.neighbourhood || a.city_district || '',
    city: a.city || a.town || a.municipality || '',
    uf: a.state_code || (a.state ? a.state.slice(0, 2).toUpperCase() : '')
  };
}

// Distância em linha reta entre dois pontos (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Aplica a fórmula de taxa (base + excedente por km, arredondada)
function calcFeeByDistance(cfg, distanceKm) {
  const baseKm = Number(cfg.feeBaseKm) || 0;
  const extraKm = Math.max(0, distanceKm - baseKm);
  let fee = (Number(cfg.feeBaseValue) || 0) + extraKm * (Number(cfg.feePerKm) || 0);
  const round = Number(cfg.feeRound) || 0;
  if (round > 0) fee = Math.ceil(fee / round) * round;
  return Math.round(fee * 100) / 100;
}

// Remove acentos e normaliza texto pra comparar bairros sem depender de
// maiúscula/minúscula ou acentuação exata (ex: "Costázul" == "costazul").
function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Acha a zona de CEP configurada que melhor bate com o CEP informado,
// testando do prefixo mais específico (8 dígitos) ao menos específico.
function matchCepZone(cep, zones) {
  const clean = String(cep || '').replace(/\D/g, '');
  if (!clean || !Array.isArray(zones) || !zones.length) return null;
  const withPrefix = zones.map(z => ({ ...z, p: String(z.prefix || '').replace(/\D/g, '') })).filter(z => z.p);
  const sorted = withPrefix.sort((a, b) => b.p.length - a.p.length); // mais específico primeiro
  return sorted.find(z => clean.startsWith(z.p)) || null;
}

// Acha a zona de bairro configurada que bate com o bairro informado
// (comparação exata primeiro, depois por aproximação/inclusão de texto).
function matchBairroZone(hood, zones) {
  const h = normalizeText(hood);
  if (!h || !Array.isArray(zones) || !zones.length) return null;
  const exact = zones.find(z => normalizeText(z.bairro) === h);
  if (exact) return exact;
  return zones.find(z => {
    const zb = normalizeText(z.bairro);
    return zb && (h.includes(zb) || zb.includes(h));
  }) || null;
}


// v73: extrai o bairro a partir do texto livre do endereço, pra pedidos antigos que não têm
// o campo order.hood salvo separadamente (o checkout monta o endereço como
// "Rua X, 123 - Bairro - Complemento (Referência) · CEP 00000-000" — ver public/index.html).
// Best-effort: se não conseguir identificar, devolve string vazia (o pedido some da quebra por
// bairro no relatório, mas continua entrando nos totais gerais).
function extractHoodFromAddress(address) {
  const addr = String(address || '');
  const afterDash = addr.split(' - ').slice(1).join(' - '); // tudo depois de "Rua, Nº - "
  if (!afterDash) return '';
  let hood = afterDash.split(' - ')[0] || '';
  hood = hood.split(' (')[0].split(' · ')[0].trim();
  return hood.slice(0, 60);
}

// Acha um cupom válido pelo código (não expirado, ativo, dentro do limite de uso
// e do pedido mínimo) e devolve o desconto já calculado pra esse subtotal.
function findValidCoupon(cfg, code, subtotal) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { error: 'Informe um cupom.' };
  const coupon = (cfg.coupons || []).find(x => String(x.code || '').toUpperCase() === c);
  if (!coupon) return { error: 'Cupom não encontrado.' };
  if (coupon.active === false) return { error: 'Esse cupom não está mais ativo.' };
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return { error: 'Esse cupom expirou.' };
  if (coupon.usageLimit > 0 && (coupon.usedCount || 0) >= coupon.usageLimit) return { error: 'Esse cupom já atingiu o limite de usos.' };
  if (coupon.minOrder > 0 && subtotal < coupon.minOrder) {
    return { error: `Esse cupom vale a partir de R$ ${Number(coupon.minOrder).toFixed(2).replace('.', ',')} em pedidos.` };
  }
  let discount = 0, freeDelivery = false;
  if (coupon.type === 'percent') discount = Math.round(subtotal * (Number(coupon.value) || 0) / 100 * 100) / 100;
  else if (coupon.type === 'valor') discount = Math.min(Number(coupon.value) || 0, subtotal);
  else if (coupon.type === 'frete_gratis') freeDelivery = true;
  return { coupon, discount, freeDelivery };
}


// Envia WhatsApp via Twilio (usa a MESMA conta/API do SMS acima — Twilio manda WhatsApp e SMS pelo
// mesmo endpoint, só muda o prefixo "whatsapp:" nos números "De" e "Para"). Precisa de um número
// habilitado para WhatsApp na conta Twilio (sandbox pra testar, ou número aprovado em produção).
// Isso é OPCIONAL: sem essa conta configurada, o painel ainda oferece o botão manual de WhatsApp
// (abre wa.me com a mensagem pronta, sem custo nenhum, só que exige 1 clique de quem está no painel).
function sendWhatsApp(toPhone, body, smsCfg) {
  return new Promise((resolve, reject) => {
    if (!smsCfg.accountSid || !smsCfg.authToken || !smsCfg.fromWhatsApp) {
      return reject(new Error('WhatsApp automático não configurado.'));
    }
    const to = String(toPhone || '').replace(/\D/g, '');
    if (!to) return reject(new Error('Número de telefone inválido.'));
    const params = new url.URLSearchParams({ To: 'whatsapp:+55' + to, From: 'whatsapp:' + smsCfg.fromWhatsApp, Body: body }).toString();
    const auth = Buffer.from(`${smsCfg.accountSid}:${smsCfg.authToken}`).toString('base64');
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${smsCfg.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else { try { reject(new Error(JSON.parse(data).message || 'Falha ao enviar WhatsApp.')); } catch (e) { reject(new Error('Falha ao enviar WhatsApp.')); } }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado ao tentar enviar WhatsApp.')); });
    req.write(params);
    req.end();
  });
}

// Textos automáticos por status — usados no WhatsApp automático (se configurado)
const WHATSAPP_STATUS_MESSAGES = {
  preparando: (o, cfg) => `🍣 *${cfg.name}*\nOi ${o.name}! Seu pedido foi *aceito* e já está sendo preparado. Previsão: ${cfg.time}.`,
  saiu: (o, cfg) => o.mode === 'delivery'
    ? `🛵 *${cfg.name}*\nSeu pedido saiu para entrega! Chega até você em instantes.`
    : `🏪 *${cfg.name}*\nSeu pedido está *pronto* para retirada no restaurante!`,
  entregue: (o, cfg) => `✅ *${cfg.name}*\nPedido entregue! Obrigado pela preferência 🙏${o.pointsEarned ? ` Você ganhou ${o.pointsEarned} pontos de fidelidade.` : ''}`,
  cancelado: (o, cfg) => `⛔ *${cfg.name}*\nSeu pedido foi cancelado. Motivo: ${o.cancelReason || 'não informado'}. Qualquer dúvida, chama a gente!`
};
// v27: mesmas mensagens de status, só que pra notificação push (title/body curtos, sem markdown)
const PUSH_STATUS_MESSAGES = {
  preparando: (o, cfg) => ({ title: cfg.name, body: `Seu pedido foi aceito e já está sendo preparado. Previsão: ${cfg.time}.` }),
  saiu: (o, cfg) => ({ title: cfg.name, body: o.mode === 'delivery' ? '🛵 Seu pedido saiu para entrega!' : '🏪 Seu pedido está pronto para retirada!' }),
  entregue: (o, cfg) => ({ title: cfg.name, body: '✅ Pedido entregue! Obrigado pela preferência.' }),
  cancelado: (o, cfg) => ({ title: cfg.name, body: `⛔ Seu pedido foi cancelado. Motivo: ${o.cancelReason || 'não informado'}.` })
};
// v79: manda uma notificação push pra TODOS os aparelhos da LOJA que ativaram o alerta (PC do
// balcão, celular do dono, tablet da cozinha etc. — cada um vira uma inscrição separada em
// ADMIN_PUSH_SUBS_FILE). É isso que garante o alerta chegar simultâneo em todos, mesmo com a
// aba/app fechado — nunca trava nem derruba quem chamou (resolve sozinho, sem rejeitar).
async function sendAdminPush(payload) {
  try {
    const { cfg } = readConfig();
    if (!cfg.vapid || !cfg.vapid.publicKey || !cfg.vapid.privateKeyJwk) return { sent: 0, failed: 0 };
    let subs = readJSON(ADMIN_PUSH_SUBS_FILE);
    if (!subs.length) return { sent: 0, failed: 0 };
    let sent = 0, failed = 0;
    const expired = [];
    for (const sub of subs) {
      // v81: `silent` agora é por aparelho (cada um escolhe em Configurações → 🔔 Notificações
      // Push → "🔇 Silenciar som do sistema neste aparelho"), não mais fixo pra todo mundo —
      // por isso o payload é montado de novo pra cada inscrição, em vez de mandar o mesmo
      // objeto pra todas.
      const perDevicePayload = { ...payload, silent: !!sub.silent };
      const r = await webpush.sendWebPush(sub, perDevicePayload, cfg.vapid, cfg.vapid.subject);
      if (r.ok) sent++; else { failed++; if (r.expired) expired.push(sub.endpoint); }
    }
    if (expired.length) writeJSON(ADMIN_PUSH_SUBS_FILE, subs.filter(s => !expired.includes(s.endpoint)));
    return { sent, failed };
  } catch (e) { return { sent: 0, failed: 0 }; }
}
// Usa https puro (sem dependências) fazendo POST form-urlencoded com Basic Auth.
function sendSMS(toPhone, body, smsCfg) {
  return new Promise((resolve, reject) => {
    if (!smsCfg.accountSid || !smsCfg.authToken || !smsCfg.fromNumber) {
      return reject(new Error('SMS não configurado. Cadastre sua conta Twilio em Configurações → SMS.'));
    }
    const to = String(toPhone || '').replace(/\D/g, '');
    if (!to) return reject(new Error('Número de telefone inválido.'));
    const params = new url.URLSearchParams({ To: '+55' + to, From: smsCfg.fromNumber, Body: body }).toString();
    const auth = Buffer.from(`${smsCfg.accountSid}:${smsCfg.authToken}`).toString('base64');
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${smsCfg.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else { try { reject(new Error(JSON.parse(data).message || 'Falha ao enviar SMS.')); } catch (e) { reject(new Error('Falha ao enviar SMS.')); } }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado ao tentar enviar SMS.')); });
    req.write(params);
    req.end();
  });
}

// ─── IA de atendimento (v57) — multi-provedor. O restaurante escolhe qual usar em
// Configurações → Atendimento: Anthropic (paga), ou Groq / OpenRouter / Hugging Face / Google
// Gemini (todos com camada gratuita hoje). Tudo opcional: sem chave cadastrada, ou com o modo
// "manual" escolhido, as funções de IA nem são chamadas — o caixa responde na mão (ver mais
// abaixo, seção "Atendimento — conversas").
const IA_PROVEDORES = {
  anthropic:   { label: 'Anthropic (Claude) — pago',        modeloPadrao: 'claude-sonnet-5' },
  // v98 — AI ROUTER: Groq agora tem um modelo de TEXTO e um modelo de VISÃO separados.
  // modeloPadrao continua existindo (= modeloPadraoTexto) só pra não quebrar nada que já lia esse
  // campo antes da v98. qwen/qwen3.6-27b é multimodal (lê imagem) — ver detecção em chamarIA().
  groq:        { label: 'Groq — grátis',                    modeloPadrao: 'openai/gpt-oss-120b', modeloPadraoTexto: 'openai/gpt-oss-120b', modeloPadraoVisao: 'qwen/qwen3.6-27b' },
  openrouter:  { label: 'OpenRouter — grátis',               modeloPadrao: 'meta-llama/llama-3.3-70b-instruct:free' },
  huggingface: { label: 'Hugging Face — grátis',             modeloPadrao: 'meta-llama/Llama-3.3-70B-Instruct' },
  gemini:      { label: 'Google Gemini — grátis',            modeloPadrao: 'gemini-2.0-flash' }
};
// Formato genérico de mensagem usado internamente: { role:'user'|'assistant', content: string |
// [{type:'text',text} | {type:'image', mediaType, data}] } — convertido pro formato de cada
// provedor dentro de cada função abaixo.
function chamarOpenAICompativel(hostname, path, mensagens, apiKey, modelo, maxTokens, extraHeaders) {
  return new Promise((resolve, reject) => {
    const msgsConvertidas = mensagens.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p =>
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
      )
    }));
    const body = JSON.stringify({ model: modelo, messages: msgsConvertidas, max_tokens: maxTokens || 800 });
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(extraHeaders || {}) },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve((parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '');
          } else {
            reject(new Error((parsed.error && (parsed.error.message || parsed.error)) || `Falha ao consultar ${hostname}.`));
          }
        } catch (e) { reject(new Error(`Resposta inválida de ${hostname}.`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado ao consultar a IA.')); });
    req.write(body);
    req.end();
  });
}
function chamarAnthropic(mensagens, apiKey, modelo, maxTokens) {
  return new Promise((resolve, reject) => {
    const msgsConvertidas = mensagens.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p =>
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
      )
    }));
    const body = JSON.stringify({ model: modelo, max_tokens: maxTokens || 800, messages: msgsConvertidas });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve((parsed.content || []).map(b => b.text || '').filter(Boolean).join('\n'));
          } else {
            reject(new Error((parsed.error && parsed.error.message) || 'Falha ao consultar a Anthropic.'));
          }
        } catch (e) { reject(new Error('Resposta inválida da Anthropic.')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado ao consultar a IA.')); });
    req.write(body);
    req.end();
  });
}
function chamarGemini(mensagens, apiKey, modelo, maxTokens) {
  return new Promise((resolve, reject) => {
    const contents = mensagens.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(p =>
        p.type === 'text' ? { text: p.text } : { inline_data: { mime_type: p.mediaType, data: p.data } }
      )
    }));
    const body = JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens || 800 } });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const partes = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts || [];
            resolve(partes.map(p => p.text || '').join('\n'));
          } else {
            reject(new Error((parsed.error && parsed.error.message) || 'Falha ao consultar o Gemini.'));
          }
        } catch (e) { reject(new Error('Resposta inválida do Gemini.')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado ao consultar a IA.')); });
    req.write(body);
    req.end();
  });
}
// ═══════════════════════════════════════════════════════════
// v98 — AI ROUTER: detecta texto x imagem, escolhe o melhor modelo, tenta de novo sozinho num
// fallback quando o provedor principal falha por limite/indisponibilidade (nunca por erro de
// conteúdo), registra o uso em log (sem chave de API) e cacheia leitura de imagem repetida.
// Fluxo: USUÁRIO → chamarIA() → detecta tipo → escolhe modelo → executa → se falhar (erro
// transitório) → fallback automático → se todos falharem → erro claro (nunca inventa dado; quem
// chama decide se cai pro modo básico local, ver respostaModoBasico()).
// ═══════════════════════════════════════════════════════════

// Erros que valem tentar de novo com outro modelo/provedor (limite de uso, indisponibilidade
// temporária) — bem diferente de erro de credencial/formato, que fallback nenhum resolve.
function ehErroTransitorio(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /429|rate.?limit|quota|timeout|tempo esgotado|503|502|504|unavailable|indispon[íi]vel|overloaded|sobrecarreg/.test(msg);
}
function hashImagemIA(base64) {
  return crypto.createHash('sha1').update(String(base64 || '')).digest('hex');
}
// Cache simples em disco (arquivo JSON) pra não reanalisar a mesma foto de nota fiscal/catálogo
// duas vezes. Capado em 200 entradas (mais antigas saem primeiro) — restaurante não precisa disso
// crescendo pra sempre.
function cacheImagemIA_ler(hash) {
  try { const c = readJSON(IA_CACHE_FILE); return c[hash] || null; } catch (e) { return null; }
}
function cacheImagemIA_salvar(hash, resultado) {
  try {
    const c = readJSON(IA_CACHE_FILE);
    c[hash] = { resultado, ts: new Date().toISOString() };
    const chaves = Object.keys(c);
    if (chaves.length > 200) {
      chaves.sort((a, b) => new Date(c[a].ts) - new Date(c[b].ts));
      chaves.slice(0, chaves.length - 200).forEach(k => delete c[k]);
    }
    writeJSON(IA_CACHE_FILE, c);
  } catch (e) { /* cache é só otimização — nunca derruba a leitura por causa dele */ }
}
// Log de uso da IA — provedor, modelo, tempo de resposta, erro e se usou fallback. NUNCA grava
// API Key. Capado em 300 linhas (mais antigas saem primeiro). Também alimenta o "status da IA".
function logIA({ provedor, modelo, tipo, tempoMs, erro, fallbackUsado }) {
  try {
    const log = readJSON(IA_LOG_FILE);
    log.push({ ts: new Date().toISOString(), provedor, modelo, tipo, tempoMs, erro: erro ? String(erro).slice(0, 300) : null, fallbackUsado: !!fallbackUsado });
    if (log.length > 300) log.splice(0, log.length - 300);
    writeJSON(IA_LOG_FILE, log);
  } catch (e) { /* log nunca pode derrubar a chamada de IA em si */ }
}
// Status visível em Configurações → Atendimento, calculado a partir do log recente (últimos 20
// registros) — reflete a situação real, não um valor fixo.
function calcularStatusIA(iaCfg) {
  if (!iaCfg || !iaCfg.enabled || !iaCfg.apiKey) return { status: 'desativada', label: 'IA desativada' };
  let log = [];
  try { log = readJSON(IA_LOG_FILE); } catch (e) {}
  const recentes = log.slice(-20);
  if (!recentes.length) return { status: 'online', label: '🟢 IA online' };
  const ultimoErro = [...recentes].reverse().find(l => l.erro);
  const teveFallback = recentes.some(l => l.fallbackUsado);
  if (ultimoErro && ultimoErro === recentes[recentes.length - 1]) return { status: 'limitada', label: '🟠 IA limitada (última tentativa falhou)' };
  if (teveFallback) return { status: 'fallback', label: '🟡 IA com fallback (usando modelo alternativo)' };
  return { status: 'online', label: '🟢 IA online' };
}

// Detecta se existe imagem dentro das mensagens (formato interno, ver comentário acima de
// chamarOpenAICompativel).
function mensagensTemImagem(mensagens) {
  return mensagens.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
}

// Executa uma única tentativa (provedor+modelo) e devolve a Promise de texto, sem fallback —
// usado internamente pelo roteador abaixo.
function executarTentativaIA(provedor, apiKey, modelo, mensagens, maxTokens) {
  if (provedor === 'anthropic') return chamarAnthropic(mensagens, apiKey, modelo, maxTokens);
  if (provedor === 'gemini') return chamarGemini(mensagens, apiKey, modelo, maxTokens);
  if (provedor === 'groq') return chamarOpenAICompativel('api.groq.com', '/openai/v1/chat/completions', mensagens, apiKey, modelo, maxTokens);
  if (provedor === 'openrouter') return chamarOpenAICompativel('openrouter.ai', '/api/v1/chat/completions', mensagens, apiKey, modelo, maxTokens, { 'HTTP-Referer': 'https://shogatsu.local', 'X-Title': 'Shogatsu' });
  if (provedor === 'huggingface') return chamarOpenAICompativel('router.huggingface.co', '/v1/chat/completions', mensagens, apiKey, modelo, maxTokens);
  return Promise.reject(new Error('Provedor de IA desconhecido: ' + provedor));
}

// Despachante único — todo o resto do sistema chama só isso, sem saber qual provedor está por
// trás. A partir da v98 isso é o AI ROUTER: escolhe o modelo certo pra texto/imagem, tenta de
// novo sozinho (fallback) quando o principal falha por limite/indisponibilidade, e nunca deixa a
// chamada travada (todo fallback é tentado em sequência, nunca em loop).
function chamarIA(mensagens, iaCfg, maxTokens) {
  if (!iaCfg || !iaCfg.enabled || !iaCfg.apiKey) {
    return Promise.reject(new Error('IA de atendimento não configurada. Cadastre em Configurações → Atendimento.'));
  }
  const provedor = IA_PROVEDORES[iaCfg.provider] ? iaCfg.provider : 'anthropic';
  const temImagem = mensagensTemImagem(mensagens);
  const fallbackLigado = iaCfg.fallbackAutomatico !== false; // padrão: ligado

  // v95/v98 — modelos padrão do OpenRouter/Hugging Face configurados aqui são só de TEXTO, sem
  // visão de verdade — mantém o aviso claro em português (Groq NÃO entra mais aqui: a partir da
  // v98 o Groq lê foto sozinho usando qwen/qwen3.6-27b, escolhido automaticamente abaixo).
  if (temImagem && (provedor === 'openrouter' || provedor === 'huggingface')) {
    return Promise.reject(new Error(
      `O provedor "${IA_PROVEDORES[provedor].label}" não lê fotos, só texto — ` +
      `essa função de ler foto (nota fiscal/catálogo) funciona com Groq, Anthropic (Claude) ou Google Gemini. ` +
      `Troque o provedor em Configurações → Atendimento pra usar a leitura de foto, ou digite os itens na mão.`
    ));
  }

  // Monta a lista de tentativas (router), na ordem em que devem ser feitas.
  const tentativas = [];
  if (provedor === 'groq') {
    const modeloTexto = iaCfg.modelo || IA_PROVEDORES.groq.modeloPadraoTexto;
    const modeloVisao = iaCfg.modeloVisao || IA_PROVEDORES.groq.modeloPadraoVisao;
    if (temImagem) {
      tentativas.push({ provedor: 'groq', modelo: modeloVisao });
    } else {
      tentativas.push({ provedor: 'groq', modelo: modeloTexto });
      // fallback dentro do próprio Groq: o modelo multimodal também responde texto puro.
      if (fallbackLigado && modeloVisao !== modeloTexto) tentativas.push({ provedor: 'groq', modelo: modeloVisao });
    }
    // Gemini como fallback OPCIONAL (nunca obrigatório) — só entra se GEMINI_API_KEY existir nas
    // variáveis de ambiente do servidor. Sem isso, o sistema segue funcionando só com Groq.
    if (fallbackLigado && process.env.GEMINI_API_KEY) {
      tentativas.push({ provedor: 'gemini', modelo: 'gemini-2.0-flash', apiKey: process.env.GEMINI_API_KEY });
    }
  } else {
    // Outros provedores (anthropic/openrouter/huggingface/gemini escolhidos manualmente): mantém
    // o comportamento de sempre — uma tentativa, com o modelo configurado ou o padrão.
    const modelo = iaCfg.modelo || IA_PROVEDORES[provedor].modeloPadrao;
    tentativas.push({ provedor, modelo });
  }

  let ultimoErro = null;
  let indice = 0;
  function tentarProxima() {
    if (indice >= tentativas.length) {
      logIA({ provedor, modelo: tentativas[0] && tentativas[0].modelo, tipo: temImagem ? 'imagem' : 'texto', tempoMs: 0, erro: ultimoErro, fallbackUsado: indice > 1 });
      return Promise.reject(ultimoErro || new Error('Nenhum provedor de IA disponível no momento.'));
    }
    const t = tentativas[indice];
    const apiKeyDaTentativa = t.apiKey || iaCfg.apiKey;
    const inicio = Date.now();
    return executarTentativaIA(t.provedor, apiKeyDaTentativa, t.modelo, mensagens, maxTokens)
      .then(resultado => {
        logIA({ provedor: t.provedor, modelo: t.modelo, tipo: temImagem ? 'imagem' : 'texto', tempoMs: Date.now() - inicio, erro: null, fallbackUsado: indice > 0 });
        return resultado;
      })
      .catch(err => {
        ultimoErro = err;
        const podeTentarProxima = fallbackLigado && ehErroTransitorio(err) && indice + 1 < tentativas.length;
        logIA({ provedor: t.provedor, modelo: t.modelo, tipo: temImagem ? 'imagem' : 'texto', tempoMs: Date.now() - inicio, erro: err.message, fallbackUsado: indice > 0 });
        if (!podeTentarProxima) {
          // Erro definitivo (não é limite/indisponibilidade, ou fallback está desligado, ou
          // acabaram as tentativas) — nunca fica preso tentando pra sempre.
          if (temImagem && indice + 1 >= tentativas.length) {
            return Promise.reject(new Error('A leitura visual está temporariamente indisponível. As outras funções do sistema continuam funcionando normalmente.'));
          }
          return Promise.reject(err);
        }
        indice++;
        return tentarProxima();
      });
  }
  return tentarProxima();
}

// v98 — MODO BÁSICO: resposta local, sem nenhuma IA, pra o chat de atendimento nunca ficar sem
// nenhuma resposta quando nenhuma API está disponível (não configurada, ou todo o fallback já foi
// tentado e falhou). Nunca inventa informação — só orienta o cliente com o que o sistema sabe de
// verdade (cardápio/config), e sempre oferece "falar com atendente".
function respostaModoBasico(historicoMensagens, cfg) {
  const ultima = (historicoMensagens[historicoMensagens.length - 1] || {}).texto || '';
  const t = ultima.toLowerCase();
  if (/^(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[ií]|hey)\b/.test(t.trim())) {
    return `Oi! No momento o atendimento automático está limitado, mas posso te orientar: dá uma olhada no cardápio aí em cima pra ver os pratos e preços, ou toque em "Falar com atendente" que alguém te ajuda rapidinho.`;
  }
  if (/pedido|pedir|comprar|fazer.*pedido/.test(t)) {
    return `Pra fazer seu pedido: escolha os pratos no cardápio, adicione ao carrinho e finalize com seus dados de entrega. Qualquer dúvida no meio do caminho, é só tocar em "Falar com atendente".`;
  }
  if (/hor[áa]rio|aberto|fechado|funcionamento/.test(t)) {
    return `Nosso horário de funcionamento: ${cfg.days || ''}, ${cfg.hours || ''}. Se estiver em dúvida se estamos abertos agora, toque em "Falar com atendente" pra confirmar.`;
  }
  if (/foto|imagem|print|nota fiscal/.test(t)) {
    return `No momento não consigo analisar fotos automaticamente — toque em "Falar com atendente" que alguém confere pra você.`;
  }
  return `No momento não consigo responder automaticamente com detalhes. Toque em "Falar com atendente" que alguém te responde, ou dá uma olhada no cardápio aí em cima.`;
}
// Responde a dúvida de um cliente do cardápio, usando o cardápio atual e o histórico da conversa
// como contexto. Se houver FAQ pré-cadastrada, ela entra também — a IA prioriza essas respostas.
function perguntarIA(historicoMensagens, iaCfg, cfg, menu) {
  const itensTexto = (menu || []).flatMap(cat => (cat.items || []).map(it => `- ${it.name}: R$ ${Number(it.price || 0).toFixed(2)}`)).join('\n');
  const faqTexto = (iaCfg.faq || []).map(f => `P: ${f.pergunta}\nR: ${f.resposta}`).join('\n\n');
  const sistema = `Você é o atendimento automático do restaurante "${cfg.name}", conversando com um cliente ` +
    `no próprio site de pedidos. Responda curto, simpático, em português do Brasil, sem inventar informação ` +
    `que você não tem (se não souber, sugira o botão "Falar com atendente"). Se a pergunta do cliente bater com ` +
    `alguma das Perguntas Frequentes abaixo, use aquela resposta como base. Você já tem a lista completa do ` +
    `cardápio abaixo — sempre que o cliente pedir "o cardápio", "opções", "o que vocês têm" ou parecer indeciso ` +
    `sobre o que pedir, liste diretamente os pratos (com preço) e, se fizer sentido, recomende 2-3 opções mais ` +
    `pedidas ou combine com o que ele descreveu gostar — nunca apenas mande ele olhar o cardápio na tela sem ` +
    `ajudar, já que você tem essa informação em mãos.\n\n` +
    `Perguntas Frequentes cadastradas:\n${faqTexto || '(nenhuma)'}\n\n` +
    `Cardápio atual:\n${itensTexto || '(cardápio vazio no momento)'}\n\n` +
    `Horário: ${cfg.days}, ${cfg.hours}. Taxa de entrega: R$ ${Number(cfg.fee || 0).toFixed(2)}. Pedido mínimo: R$ ${Number(cfg.min || 0).toFixed(2)}.`;
  const mensagens = [{ role: 'user', content: sistema + '\n\n(Confirme que entendeu respondendo apenas "ok".)' }, { role: 'assistant', content: 'ok' },
    ...historicoMensagens.map(m => ({ role: m.de === 'cliente' ? 'user' : 'assistant', content: m.texto }))];
  return chamarIA(mensagens, iaCfg, 500);
}
// Lê uma foto de nota fiscal (custo de compra) ou catálogo/cardápio (preço de venda) e devolve uma
// lista de itens em JSON — usada em Custos & Ficha Técnica pra sugerir ingredientes sem digitar.
// v98: passa a usar cache por hash da imagem (evita reanalisar a mesma foto) — resultado idêntico
// de antes pra quem chama esta função, só mais rápido/barato na segunda vez.
// v106 — BUG CORRIGIDO ("Unexpected token '<', \"<think> Th\"... is not valid JSON" ao ler foto de
// nota fiscal/catálogo): alguns modelos de IA com "raciocínio" (ex.: modelos que expõem
// chain-of-thought, como o modelo de visão padrão configurado) respondem com um bloco
// `<think>...</think>` de raciocínio ANTES do JSON pedido — mesmo quando o prompt pede
// explicitamente "sem texto antes ou depois". Antes, a limpeza da resposta só removia as cercas
// de markdown (```json ```), então esse `<think>` sobrava e quebrava o JSON.parse logo na
// primeira tentativa de leitura — em TODAS as ferramentas que leem foto/pedem JSON da IA (Ler
// Nota Fiscal, Ler Imagem de Custos, sugestão de ficha técnica, sugestão de prato novo). Extraído
// aqui numa função só, reaproveitada nas 4 (evita repetir a mesma correção 4 vezes e esquecer
// alguma). Continua funcionando exatamente igual quando a IA responde limpa (comportamento mais
// comum) — só entra em ação a mais quando sobra alguma coisa around o JSON.
function extrairJSONdaIA(texto) {
  let limpo = String(texto || '')
    .replace(/```json|```/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // bloco de raciocínio fechado corretamente
    .replace(/<think>[\s\S]*$/gi, '') // bloco de raciocínio que ficou aberto (sem fechar) — remove até o fim
    .trim();
  try { return JSON.parse(limpo); } catch (e) { /* tenta o plano B abaixo antes de desistir */ }
  // Plano B: se ainda sobrou algum texto antes/depois do JSON de verdade, pega só do primeiro
  // "{" ou "[" até o "}" ou "]" que fecha ele (o maior trecho válido dentro da resposta).
  const inicio = limpo.search(/[{[]/);
  if (inicio === -1) throw new Error('A IA não respondeu com um JSON válido.');
  const abre = limpo[inicio], fecha = abre === '{' ? '}' : ']';
  const fim = limpo.lastIndexOf(fecha);
  if (fim === -1 || fim <= inicio) throw new Error('A IA não respondeu com um JSON válido.');
  return JSON.parse(limpo.slice(inicio, fim + 1));
}

function lerImagemIA(base64, mediaType, tipo, iaCfg) {
  const hash = hashImagemIA(base64) + ':' + tipo;
  const doCache = cacheImagemIA_ler(hash);
  if (doCache) return Promise.resolve(doCache.resultado);
  const instrucao = tipo === 'catalogo'
    ? 'Leia esta imagem de um catálogo ou cardápio com preços. Extraia cada produto e seu preço de venda. Responda APENAS com um JSON array no formato [{"nome":"...","preco":0.0}], sem texto antes ou depois, sem markdown.'
    : 'Leia esta imagem de uma nota fiscal de compra. Extraia cada item comprado, a quantidade e o valor total pago por ele. Responda APENAS com um JSON array no formato [{"nome":"...","quantidade":0,"valorTotal":0.0}], sem texto antes ou depois, sem markdown.';
  const content = [{ type: 'text', text: instrucao }, { type: 'image', mediaType: mediaType || 'image/jpeg', data: base64 }];
  return chamarIA([{ role: 'user', content }], iaCfg, 1500).then(texto => {
    const resultado = extrairJSONdaIA(texto);
    cacheImagemIA_salvar(hash, resultado);
    return resultado;
  });
}
// v98 — leitura ESTRUTURADA de nota fiscal (cabeçalho + itens), formato mais completo que
// lerImagemIA(tipo='nota') — que continua existindo do jeito de sempre pra não quebrar quem já
// usa. Esta função é aditiva: nova rota /api/custos/ler-nota-fiscal (ver mais abaixo), sem mudar
// o contrato de /api/custos/ler-imagem. Nunca inventa dado: campo ilegível vem null.
// v99 — ampliada pra ferramenta isolada "📷 Ler Nota Fiscal" (public/nota-fiscal.html): agora
// também extrai chave de acesso, série, IE, endereço do emitente, destinatário+CNPJ, e por
// produto NCM/CST/CFOP, além de base ICMS, valor ICMS, desconto e frete da nota. Nenhuma outra
// tela/função do sistema chama esta função — ampliar o schema aqui não afeta nada existente.
function lerNotaFiscalEstruturadaIA(base64, mediaType, iaCfg) {
  const hash = hashImagemIA(base64) + ':nota-estruturada-v99';
  const doCache = cacheImagemIA_ler(hash);
  if (doCache) return Promise.resolve(doCache.resultado);
  const instrucao = 'Leia esta imagem de uma Nota Fiscal Eletrônica (NF-e/DANFE). Extraia SOMENTE o que estiver ' +
    'visível e legível na nota — número da NF-e, série, chave de acesso, data de emissão, dados do emitente/' +
    'fornecedor (nome, CNPJ, inscrição estadual, endereço), dados do destinatário (nome, CNPJ), e cada produto ' +
    '(código, descrição, NCM, CST, CFOP, unidade, quantidade, valor unitário, valor total), e os totais da nota ' +
    '(base de cálculo do ICMS, valor do ICMS, desconto, frete, valor total da nota). ' +
    'Responda APENAS com um JSON (sem markdown, sem texto antes/depois) no formato exato: ' +
    '{"numero_nota":"","serie":"","chave_acesso":"","data_emissao":"",' +
    '"emitente":{"nome":"","cnpj":"","inscricao_estadual":"","endereco":""},' +
    '"destinatario":{"nome":"","cnpj":""},' +
    '"produtos":[{"codigo":"","descricao":"","ncm":"","cst":"","cfop":"","unidade":"","quantidade":0,"valor_unitario":0,"valor_total":0}],' +
    '"totais":{"base_icms":0,"valor_icms":0,"desconto":0,"frete":0,"valor_total_nota":0}}. ' +
    'Se algum campo não estiver legível ou não existir na nota, use null nesse campo específico — nunca invente um valor.';
  const content = [{ type: 'text', text: instrucao }, { type: 'image', mediaType: mediaType || 'image/jpeg', data: base64 }];
  return chamarIA([{ role: 'user', content }], iaCfg, 2200).then(texto => {
    const resultado = extrairJSONdaIA(texto);
    cacheImagemIA_salvar(hash, resultado);
    return resultado;
  });
}

// v93 — "IA do Cardápio deve fazer a ficha técnica dos pratos JÁ EXISTENTES no cardápio". Mesma
// ressalva de sempre: essa IA não pesquisa internet de verdade, então a ficha gerada aqui é
// sempre uma ESTIMATIVA (nunca vira "oficial" sozinha) até alguém da cozinha conferir.
function estimarFichaParaProdutoExistente(iaCfg, item, categoria, ingredientes) {
  const ingredientesTexto = (ingredientes || []).map(i => `- ${i.nome} (R$ ${i.precoUnitario}/${i.unidade})`).join('\n');
  const instrucao = `Você é uma consultora de fichas técnicas de um restaurante japonês. Esse prato JÁ EXISTE no ` +
    `cardápio e precisa de uma ficha técnica estimada (ele ainda não tem uma cadastrada):\n\n` +
    `Nome: ${item.name}\nCategoria: ${categoria}\nDescrição: ${item.description || '(sem descrição)'}\n` +
    `Preço de venda atual: R$ ${Number(item.price || 0).toFixed(2)}\n\n` +
    `Ingredientes já cadastrados no sistema (use esses de preferência, pelo NOME exato quando possível):\n${ingredientesTexto || '(nenhum)'}\n\n` +
    `Estime a receita mais provável pra esse prato (quantidades por porção/peça). Responda APENAS com um JSON ` +
    `(sem markdown, sem texto antes/depois) no formato exato:\n` +
    `{"rendimento":1,"ingredientes":[{"nome":"...","quantidade":0,"unidade":"g|kg|ml|l|un"}],"custoEstimado":0.0,"observacao":"o que te fez estimar assim"}`;
  return chamarIA([{ role: 'user', content: instrucao }], iaCfg, 900).then(texto => {
    const obj = extrairJSONdaIA(texto);
    if (!Array.isArray(obj.ingredientes) || !obj.ingredientes.length) throw new Error('A IA não retornou ingredientes válidos.');
    return obj;
  });
}


// esta IA (Groq/Anthropic/Gemini/etc, a mesma configurada em Configurações → Atendimento) NÃO
// navega na internet de verdade — a sugestão vem do conhecimento próprio do modelo, sem citar
// fonte real com data/preço verificável. Por isso toda ficha técnica gerada aqui sempre nasce
// com status "estimada" e uma origem deixando isso claro, nunca "oficial".
function sugerirNovoProdutoIA(iaCfg, cfg, menu, ingredientes, tema) {
  const itensTexto = (menu || []).flatMap(cat => (cat.items || []).map(it => `- [${cat.title}] ${it.name}: R$ ${Number(it.price || 0).toFixed(2)}`)).join('\n');
  const ingredientesTexto = (ingredientes || []).map(i => `- ${i.nome} (R$ ${i.precoUnitario}/${i.unidade})`).join('\n');
  const instrucao = `Você é uma consultora de cardápio para o restaurante japonês "${cfg.name || 'Shogatsu'}". ` +
    `Cardápio atual:\n${itensTexto || '(vazio)'}\n\nIngredientes já cadastrados (use esses de preferência, pelo NOME exato quando possível):\n${ingredientesTexto || '(nenhum)'}\n\n` +
    `${tema ? `O restaurante pediu especificamente algo relacionado a: "${tema}".` : 'Sugira um prato novo que combine com o estilo do cardápio acima e que ainda não exista nele.'} ` +
    `Responda APENAS com um JSON (sem markdown, sem texto antes/depois) no formato exato:\n` +
    `{"nome":"...","categoria":"...","descricao":"...(1-2 frases apetitosas)","rendimento":1,"badgeSugerido":"🆕 Novidade",` +
    `"ingredientes":[{"nome":"...","quantidade":0,"unidade":"g|kg|ml|l|un"}],` +
    `"custoEstimado":0.0,"precoSugerido":0.0,"margemEstimadaPercentual":0,"justificativa":"por que esse prato pode vender bem aqui"}\n` +
    `As quantidades de ingredientes e o custo são uma ESTIMATIVA sua (não pesquisa real na internet) — deixe claro no campo "justificativa" que são valores de referência a conferir.`;
  return chamarIA([{ role: 'user', content: instrucao }], iaCfg, 1200).then(texto => {
    const obj = extrairJSONdaIA(texto);
    if (!obj.nome) throw new Error('A IA não retornou um nome de prato válido.');
    return obj;
  });
}


// ─── Impressão — rede (ESC/POS via TCP) e USB (dispositivo local) ───
// Comandos ESC/POS básicos
const ESC = {
  init: '\x1B\x40',
  // v129 — BUG CORRIGIDO ("erro de encoding, caracteres ã ç é ê ó"): a impressão direta
  // (USB/rede, sem Agente Local) nunca mandava pra impressora QUAL código de página usar pra
  // interpretar os bytes de acento — o texto sai codificado em Latin-1/Windows-1252 (é o que
  // `Buffer.from(text,'binary')` produz lá embaixo em sendUSBPrint/sendNetworkPrint), mas sem
  // esse comando a impressora fica no código de página que ela trouxer de fábrica (geralmente
  // PC437, que não tem os acentos do português nesses mesmos bytes — sai símbolo errado). O
  // Agente Local (print-agent.js) já resolve isso corretamente há tempos, com a biblioteca
  // convertendo pra PC860 Português (ver characterSet em buildPrinter) — só faltava esse
  // mesmo cuidado no caminho direto do servidor. ESC t 16 seleciona WPC1252 (Windows-1252),
  // compatível com os bytes que já geramos.
  codepage: '\x1B\x74\x10',
  boldOn: '\x1B\x45\x01', boldOff: '\x1B\x45\x00',
  center: '\x1B\x61\x01', left: '\x1B\x61\x00',
  doubleOn: '\x1D\x21\x11', doubleOff: '\x1D\x21\x00',
  cut: '\x1D\x56\x01',
  // v126 — NOVO ("fazer um bip duplo ao imprimir"): comando ESC/POS padrão de campainha
  // (ESC B n t = apita "n" vezes, cada apito com duração "t"×100ms) — suportado pela grande
  // maioria das térmicas em modo ESC/POS, incluindo Bematech em modo de emulação ESC/POS.
  // n=2 já dá o bipe duplo pedido numa única comanda; se a impressora não tiver campainha
  // (ou estiver desligada no hardware), o comando é simplesmente ignorado, sem erro nenhum.
  beep: '\x1B\x42\x02\x02',
  feed: '\n\n\n'
};
// v126 — NOVO: quantas colunas de texto usar pra alinhar valores à direita e desenhar as
// linhas tracejadas na impressão direta (USB/rede sem Agente Local) — depende da largura
// real da bobina configurada em cfg.printWidth (ver default acima). 80mm comporta bem mais
// texto por linha que 58mm; usar sempre 32 (tamanho de 58mm) deixava uma bobina de 80mm com
// metade da largura sobrando sem uso nenhum.
function printCols(cfg) { return (cfg && cfg.printWidth === '58mm') ? 32 : 48; }

// v84 — BUG CORRIGIDO ("cliente marca opção de pagamento deve aparecer como pagamento na
// entrega"): PIX é pago ANTES (pelo gateway/confirmação manual), mas dinheiro/crédito/débito
// escolhidos num pedido delivery são sempre cobrados só na hora da entrega — a comanda (e o
// painel) mostravam só "Dinheiro"/"Cartão de Crédito" cru, sem deixar claro isso pro motoboy/
// caixa, que às vezes achava que já tinha sido pago. Agora qualquer forma que não seja PIX
// ganha o sufixo "(PAGAMENTO NA ENTREGA)" ou "(PAGAMENTO NA RETIRADA)", dependendo do modo do
// pedido — usado em toda comanda impressa (rede/USB/Agente Local) e no painel.
const PAY_METHOD_LABELS = { pix: 'PIX', credito: 'Cartão de Crédito', debito: 'Cartão de Débito', dinheiro: 'Dinheiro' };
function payMethodTicketLabel(order) {
  const base = PAY_METHOD_LABELS[order.payMethod] || order.payMethod || '-';
  if (!order.payMethod || order.payMethod === 'pix') return base;
  return base + (order.mode === 'delivery' ? ' (PAGAMENTO NA ENTREGA)' : ' (PAGAMENTO NA RETIRADA)');
}

// Monta o texto puro do ticket (usado tanto na pré-visualização quanto na impressão real).
// v92 — BUG CORRIGIDO ("tamanho da fonte na impressão não está ajustando corretamente"): antes
// só existiam DOIS estados (normal ou "dobrado" em cfg.printSize >= 18) — então mudar o campo
// de 14 pra 17, ou de 19 pra 27, não tinha efeito nenhum na impressora de rede/USB direta.
// Impressoras térmicas não trocam de "fonte" de verdade (só têm a fonte gravada no hardware),
// mas o comando ESC/POS "GS ! n" permite multiplicar altura e largura em até 8x cada, de forma
// independente — usamos isso pra dar mais degraus reais dentro da faixa de 10 a 28px da tela de
// Configurações. Só a ALTURA aumenta nos degraus intermediários (a largura fica normal) pra não
// estourar a largura da bobina e quebrar a linha no meio de uma palavra; a largura só dobra
// junto no degrau mais alto, onde isso já é claramente a intenção ("letra bem grande").
function tamanhoImpressaoTermica(printSize) {
  const s = Number(printSize) || 14;
  let alturaMult = 0, larguraMult = 0; // 0 = tamanho padrão da impressora (não dá pra ficar MENOR que isso)
  if (s >= 26) { alturaMult = 3; larguraMult = 1; }      // bem grande: altura 4x + largura 2x
  else if (s >= 22) { alturaMult = 2; }                   // altura 3x, largura normal
  else if (s >= 18) { alturaMult = 1; }                   // altura 2x, largura normal (era o único "grande" antes)
  // abaixo de 18 (10 a 17): tamanho padrão da impressora — térmica não imprime menor que isso
  const n = (larguraMult << 4) | alturaMult;
  // v128 — NOVO ("nome do item deve ser maior e em negrito"): variante "wide" — mesma altura
  // configurada (alturaMult), largura +1 nível (até o teto de 7 que o comando ESC/POS aceita)
  // — usada só no NOME do item nas vias de produção (ver buildTicketText/uso abaixo). Nunca
  // usa ESC.doubleOff (reset pra ZERO) pra voltar — sempre volta pro `on` normal configurado,
  // senão perderia o tamanho escolhido pelo lojista pro resto do ticket depois do nome.
  const nWide = (Math.min(larguraMult + 1, 7) << 4) | alturaMult;
  return { on: '\x1D\x21' + String.fromCharCode(n), off: ESC.doubleOff, wideOn: '\x1D\x21' + String.fromCharCode(nWide) };
}
function buildTicketText(lines, cfg) {
  const tam = tamanhoImpressaoTermica(cfg && cfg.printSize);
  const body = tam.on + lines.join('\n') + tam.off;
  // v126 — bipe duplo ao final de toda impressão direta (USB/rede), depois do corte —
  // avisa quem está no balcão/cozinha que saiu uma comanda nova sem precisar olhar pra
  // impressora o tempo todo.
  return ESC.init + ESC.codepage + body + ESC.feed + ESC.cut + ESC.beep;
}

// v93 — via de RESERVA DE MESA (impressora de rede/USB direta). Mesma ideia/layout das vias de
// pedido (buildTicketText acima), só que com os dados da reserva em vez do carrinho.
function buildReservationTicketText(reservation, cfg) {
  const cols = printCols(cfg);
  const HR = '-'.repeat(cols);
  const HR2 = '='.repeat(cols);
  const lines = [];
  lines.push(ESC.center + ESC.boldOn + (cfg.name || 'SHOGATSU').toUpperCase() + ESC.boldOff);
  lines.push((cfg.tagline || 'CULINARIA ORIENTAL').toUpperCase() + ESC.left);
  lines.push(HR2);
  lines.push(ESC.center + 'RESERVA DE MESA' + ESC.left);
  lines.push('Ref.: ' + reservation.id);
  lines.push('Status: ' + (reservation.status === 'confirmada' ? 'CONFIRMADA' : 'PENDENTE DE CONFIRMACAO'));
  lines.push(HR);
  lines.push(ESC.boldOn + 'CLIENTE' + ESC.boldOff);
  lines.push(HR);
  lines.push(reservation.name);
  lines.push('Tel: ' + reservation.phone);
  lines.push(HR);
  lines.push(ESC.boldOn + 'DETALHES' + ESC.boldOff);
  lines.push(HR);
  const dataFmt = reservation.date ? new Date(reservation.date + 'T00:00').toLocaleDateString('pt-BR') : '';
  lines.push('Data: ' + dataFmt);
  lines.push('Hora: ' + reservation.time);
  lines.push('Pessoas: ' + reservation.people);
  if (reservation.notes) { lines.push(HR); lines.push('Obs: ' + reservation.notes); }
  lines.push(HR2);
  lines.push(ESC.center + 'Reservado em ' + new Date(reservation.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ESC.left);
  return buildTicketText(lines, cfg);
}

// Envia bytes brutos para uma impressora de rede (porta 9100 é o padrão da maioria)
function sendNetworkPrint(ip, port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port: port || 9100, timeout: 5000 }, () => {
      socket.write(Buffer.from(text, 'binary'), () => socket.end());
    });
    socket.on('close', () => resolve(true));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout ao conectar na impressora')); });
    socket.on('error', reject);
  });
}

// Envia para um dispositivo USB local (ex: /dev/usb/lp0) — só funciona quando o
// servidor roda na mesma máquina física conectada à impressora (ex: Raspberry Pi/PC local).
// v128 — BUG CORRIGIDO ("imprimir várias vias na cozinha trava o sistema"): fs.writeFile
// NÃO TEM TIMEOUT NENHUM por padrão — se a impressora USB estivesse travada, offline, sem
// papel de um jeito que trava o buffer, ou o cabo desconectado bem na hora, essa escrita
// podia ficar PENDURADA PRA SEMPRE, nunca resolvendo nem rejeitando. Como as vias diretas
// (USB/rede) são todas enviadas juntas num Promise.all (ver /api/print no painel.html, pra
// imprimir tudo ao mesmo tempo em vez de esperar via por via), UMA impressora USB travada
// travava a impressão de TODAS as vias do pedido — inclusive vias que estavam funcionando
// perfeitamente (ex.: a cozinha ficava esperando pra sempre por causa de uma impressora de
// sushibar travada, ou vice-versa). Agora tem um teto de 8 segundos: se a escrita não
// terminar até lá, rejeita com um erro claro em vez de travar o pedido inteiro.
function sendUSBPrint(devicePath, text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Impressora USB (${devicePath}) não respondeu em 8s — pode estar travada, offline ou sem papel. As outras vias não foram afetadas.`));
    }, 8000);
    fs.writeFile(devicePath, Buffer.from(text, 'binary'), (err) => {
      if (settled) return; // já estourou o timeout — ignora essa resposta tardia
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(true);
    });
  });
}

// Preenche valores padrão em itens antigos do cardápio (sem alterar o arquivo salvo)
// v43: a via de impressão passou a ser escolhida por categoria (não item por item), então um
// item sem "stations" próprio agora herda da categoria — e só cai pra "cozinha" se nem a
// categoria tiver nada definido. Itens que já tinham uma via própria salva continuam com ela,
// sem mudar nada de repente pra quem já configurou antes.
// v49: `validStations` agora vem de fora (chaves reais de cfg.stations, incluindo qualquer via
// customizada que o admin tenha criado) em vez de uma lista fixa de 3 — antes, itens marcados
// pra uma estação nova (delivery, expedição, ou qualquer via customizada) tinham a marcação
// APAGADA sozinha aqui, e caíam de volta pra "cozinha" sem explicação nenhuma.
function normalizeMenu(menu, validStations, defaultStation) {
  validStations = (Array.isArray(validStations) && validStations.length)
    ? validStations
    : ['caixa', 'cozinha', 'sushibar', 'bar', 'delivery', 'expedicao'];
  const fallback = (defaultStation && validStations.includes(defaultStation))
    ? defaultStation
    : (validStations.includes('cozinha') ? 'cozinha' : validStations[0]);
  return (menu || []).map(sec => {
    let catStations = Array.isArray(sec.stations) ? sec.stations.filter(s => validStations.includes(s)) : [];
    if (!catStations.length) catStations = [fallback];
    return {
      ...sec,
      stations: catStations,
      items: (sec.items || []).map(it => {
        const base = { station: fallback, available: true, variants: [], ...it };
        let stations = Array.isArray(base.stations) ? base.stations.filter(s => validStations.includes(s)) : [];
        if (!stations.length) stations = catStations;
        const { station, ...rest } = base;
        return { ...rest, stations: [...new Set(stations)] };
      })
    };
  });
}

// ─── PIX — geração do payload BR Code (copia-e-cola) ───
function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function tlv(id, value) {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}
function sanitizePix(str, max) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase().slice(0, max) || 'NA';
}
function buildPixPayload({ pixKey, merchantName, merchantCity, amount, txid }) {
  if (!pixKey) return null;
  const gui = tlv('00', 'br.gov.bcb.pix');
  const key = tlv('01', pixKey.trim());
  const merchantAccount = tlv('26', gui + key);
  const mcc = tlv('52', '0000');
  const currency = tlv('53', '986');
  const value = amount != null ? tlv('54', Number(amount).toFixed(2)) : '';
  const country = tlv('58', 'BR');
  const name = tlv('59', sanitizePix(merchantName, 25));
  const city = tlv('60', sanitizePix(merchantCity, 15));
  const ref = tlv('05', sanitizePix(txid || 'PEDIDO', 25));
  const addData = tlv('62', ref);
  let payload = tlv('00', '01') + merchantAccount + mcc + currency + value + country + name + city + addData + '6304';
  return payload + crc16(payload);
}

// ─── Helpers HTTP ───
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
  });
  res.end(body);
}
function readBody(req, maxBytes = 10e6) {
  // BUG CORRIGIDO (v42 — "caixa de fotos bugada"): quando o corpo passava do limite, o
  // código só chamava req.destroy() e nunca resolvia nem rejeitava a Promise — o
  // navegador ficava esperando pra sempre (a foto travava em "Enviando..." sem erro
  // nenhum). Agora rejeita explicitamente, então o endpoint sempre responde algo, e
  // o limite subiu de 8MB pra 10MB pra caber uma imagem de 4MB convertida em base64
  // (que fica ~33% maior) com folga.
  return new Promise((resolve, reject) => {
    let chunks = '';
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      chunks += c;
      if (chunks.length > maxBytes) {
        tooLarge = true;
        reject(new Error('payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(chunks ? JSON.parse(chunks) : {}); } catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!tooLarge) reject(e); });
  });
}
function getToken(req, query) {
  const h = req.headers['authorization'];
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return query.token || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  // v53: faltavam jpg/webp (fotos de prato/splash ficavam sem Content-Type correto) e os
  // formatos de vídeo usados pelas novas "Live Photo" da Splash Screen — sem isso o
  // navegador (principalmente Safari/iOS) recusa tocar o vídeo inline.
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};

function serveStatic(req, res, pathname) {
  // Uploads (logo, fotos de prato) podem morar fora de public/ quando configurados num disco
  // persistente (UPLOADS_DIR via variável de ambiente) — por isso tem rota própria aqui.
  if (pathname.startsWith('/uploads/')) {
    const uploadPath = path.join(UPLOADS_DIR, pathname.slice('/uploads/'.length));
    if (!uploadPath.startsWith(UPLOADS_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return fs.readFile(uploadPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(uploadPath);
      // v67: nome do arquivo é um hash aleatório (nunca reaproveitado numa troca de foto — ver
      // /api/chat/background), então dá pra cachear pesado no navegador sem risco de foto trocada
      // "grudar" em cache velho — ajuda a manter o fundo do chat rápido/sem recarregar toda hora.
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
  }
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    // v44 — sistema de atualização automática: HTML e o próprio Service Worker nunca podem
    // ficar em cache do navegador (senão o cliente trava numa versão antiga sem saber); ícones,
    // manifest e demais estáticos raramente mudam, então ficam com cache longo — o SW já cuida
    // de invalidar sozinho quando a versão muda (ver public/sw.js e public/version-check.js).
    const isHtml = ext === '.html';
    const isSw = pathname === '/sw.js';
    const cacheControl = (isHtml || isSw)
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
  });
}

// ═══════════════════════════════════════════════════════════
// SERVIDOR
// ═══════════════════════════════════════════════════════════
// v105 — BUG CORRIGIDO ("leitor de nota fiscal: Unexpected token '<' ... is not valid JSON"):
// o handler principal abaixo é uma função async gigante SEM try/catch global. Qualquer exceção
// síncrona não prevista em qualquer rota (ex.: acessar campo de um objeto inesperado) virava uma
// Promise rejeitada sem handler — no Node 15+ isso DERRUBA O PROCESSO INTEIRO (unhandled
// rejection = crash por padrão). Quando o processo cai/reinicia no meio de um deploy, a
// plataforma (Render) responde com uma página HTML de erro em vez de JSON — e é essa página HTML
// que o navegador tentava interpretar como JSON (daqui vinha o "Unexpected token '<'"), não um
// problema específico da nota fiscal. Correção aditiva, não muda nenhuma rota existente: agora
// qualquer erro não previsto responde com um JSON de erro normal (500) em vez de derrubar o
// servidor — nenhum outro dispositivo/estação/impressão é afetado.
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error('⚠️  Erro não tratado numa rota:', e && e.stack || e);
    try { if (!res.headersSent) sendJSON(res, 500, { error: 'Erro interno no servidor. Tente novamente.' }); } catch (e2) {}
  }
});
// v105: mesma proteção pra qualquer promise que escape sem handler fora do request (ex.: dentro
// de setInterval/checkScheduledPush já tem seu próprio try/catch — isso aqui é só a rede de
// segurança final, nunca deveria disparar em uso normal). NUNCA derruba o processo sozinho —
// antes disso existir, um erro raro em QUALQUER rota podia tirar CAIXA+COZINHA+SUSHIBAR do ar
// ao mesmo tempo, o que é muito pior do que logar e continuar rodando.
process.on('unhandledRejection', (reason) => { console.error('⚠️  unhandledRejection:', reason && reason.stack || reason); });
process.on('uncaughtException', (err) => { console.error('⚠️  uncaughtException:', err && err.stack || err); });

async function handleRequest(req, res) {
  // v39: `url.parse()` está deprecated no Node (DEP0169) — trocado pela WHATWG URL API.
  // `query` continua sendo um objeto simples { chave: valor }, igual antes, pra não precisar
  // mexer em nenhum lugar do código que já usa `query.algumaCoisa`.
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  // v123 — admin-cardapio.html foi removido por ser apenas um atalho duplicado.
  // Mantemos a URL antiga funcionando para não quebrar favoritos/links antigos.
  if (pathname === '/admin-cardapio.html' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(301, {
      'Location': '/painel.html#cardapio',
      'Cache-Control': 'no-store'
    });
    return res.end();
  }

  if (req.method === 'OPTIONS') { return sendJSON(res, 204, {}); }

  // ── GET /api/version — usado pelo front-end (public/version-check.js) pra saber se existe
  // uma versão mais nova publicada e, se sim, atualizar sozinho sem o cliente precisar limpar
  // cache/histórico ou reinstalar nada. Não exige login — é só uma etiqueta pública. ──
  if (pathname === '/api/version' && req.method === 'GET') {
    return sendJSON(res, 200, { version: APP_VERSION, build: BUILD_COMMIT, startedAt: BUILD_STARTED_AT, pkg: PKG_VERSION });
  }

  // ── GET /api/config — dados públicos do cardápio/config ──
  if (pathname === '/api/config' && req.method === 'GET') {
    const { cfg, menu } = readConfig();
    const { adminPass, masterPass, ...publicCfg } = cfg; // nunca vaza as senhas
    // v56: a chave de API da IA também não pode vazar pro público (o cardápio é servido pra
    // qualquer visitante) — só o campo "enabled" é público, pra o cardápio saber se mostra o
    // botão de dúvidas. A pergunta em si vai pro servidor, que usa a chave guardada aqui dentro.
    publicCfg.ia = { enabled: !!(cfg.ia && cfg.ia.enabled), faq: (cfg.ia && cfg.ia.faq) || [] };
    return sendJSON(res, 200, { cfg: publicCfg, menu });
  }

  // ── POST /api/config — admin salva config/cardápio ──
  if (pathname === '/api/config' && req.method === 'POST') {
    const _cfgSession = getSession(getToken(req, query));
    if (!_cfgSession) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const _permErr = configWritePermissionCheck(_cfgSession, body);
      if (_permErr) return sendJSON(res, 403, { error: _permErr });
      const current = readConfig();
      // v49 — BUG CORRIGIDO ("excluir estação não excluía de verdade"): o merge antigo só
      // ACRESCENTAVA chaves em cfg.stations (spread de current + spread do que veio no body),
      // então uma estação removida no painel (apagada do objeto antes de enviar) reaparecia
      // sozinha aqui porque ainda existia em `current.cfg.stations`. Agora, sempre que o body
      // manda um objeto `stations` explícito, ele é tratado como a lista COMPLETA e definitiva
      // (substitui, não acrescenta) — é exatamente como o painel já trabalha (edita o cfg.stations
      // inteiro em memória e manda tudo de uma vez em "Salvar Tudo"/Configurações).
      const stationsProvided = body.cfg && body.cfg.stations && typeof body.cfg.stations === 'object';
      const stationsSrc = stationsProvided ? body.cfg.stations : current.cfg.stations;
      const stationShape = { label: '', icon: '📠', method: 'navegador', ip: '', port: 9100, device: '', prepTime: 15 };
      const mergedStations = Object.fromEntries(Object.keys(stationsSrc).map(k => [k, {
        ...stationShape, label: k,
        ...(current.cfg.stations[k] || {}),
        ...(stationsSrc[k] || {})
      }]));
      // Se alguma estação foi excluída, tira a referência dela de todas as categorias/itens do
      // cardápio também — senão o item continuava "marcado" pra uma via que não existe mais.
      const validStationKeys = Object.keys(mergedStations);
      const menuBeforeNormalize = body.menu || current.menu;
      const merged = {
        cfg: {
          ...current.cfg, ...body.cfg,
          adminPass: current.cfg.adminPass, masterPass: current.cfg.masterPass,
          stations: mergedStations,
          labels: { ...current.cfg.labels, ...(body.cfg && body.cfg.labels || {}) },
          uiFonts: { ...current.cfg.uiFonts, ...(body.cfg && body.cfg.uiFonts || {}) },
          theme: { ...current.cfg.theme, ...(body.cfg && body.cfg.theme || {}) },
          sms: { ...current.cfg.sms, ...(body.cfg && body.cfg.sms || {}) },
          ia: { ...current.cfg.ia, ...(body.cfg && body.cfg.ia || {}) },
          social: { ...current.cfg.social, ...(body.cfg && body.cfg.social || {}) },
          schedule: { ...current.cfg.schedule, ...(body.cfg && body.cfg.schedule || {}) },
          weekSchedule: (Array.isArray(body.cfg && body.cfg.weekSchedule) && body.cfg.weekSchedule.length === 7)
            ? current.cfg.weekSchedule.map((d, i) => ({ ...d, ...(body.cfg.weekSchedule[i] || {}) }))
            : current.cfg.weekSchedule,
          // v126 — NOVO: mesma validação cuidadosa do weekSchedule acima, aplicada ao horário
          // próprio de reserva (Configurações → 📅 Disponibilidade de Reserva) — protege
          // contra salvar um array incompleto/malformado que quebraria a validação de
          // horário nas próximas reservas.
          reservations: {
            ...current.cfg.reservations, ...(body.cfg && body.cfg.reservations || {}),
            schedule: (Array.isArray(body.cfg && body.cfg.reservations && body.cfg.reservations.schedule) && body.cfg.reservations.schedule.length === 7)
              ? current.cfg.reservations.schedule.map((d, i) => ({ ...d, ...(body.cfg.reservations.schedule[i] || {}) }))
              : current.cfg.reservations.schedule,
            blockedDates: Array.isArray(body.cfg && body.cfg.reservations && body.cfg.reservations.blockedDates)
              ? body.cfg.reservations.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200)
              : current.cfg.reservations.blockedDates
          },
          rodizioPopular: { ...current.cfg.rodizioPopular, ...(body.cfg && body.cfg.rodizioPopular || {}) },
          installPromo: { ...current.cfg.installPromo, ...(body.cfg && body.cfg.installPromo || {}) },
          splash: {
            ...current.cfg.splash,
            ...(body.cfg && body.cfg.splash || {}),
            photos: Array.isArray(body.cfg && body.cfg.splash && body.cfg.splash.photos) ? body.cfg.splash.photos : current.cfg.splash.photos
          },
          chatBackground: { ...current.cfg.chatBackground, ...(body.cfg && body.cfg.chatBackground || {}) },
          adminChatBackground: { ...current.cfg.adminChatBackground, ...(body.cfg && body.cfg.adminChatBackground || {}) },
          // v73
          placeholderPhoto: { ...current.cfg.placeholderPhoto, ...(body.cfg && body.cfg.placeholderPhoto || {}) },
          globalBadge: { ...current.cfg.globalBadge, ...(body.cfg && body.cfg.globalBadge || {}) },
          courierPay: {
            ...current.cfg.courierPay, ...(body.cfg && body.cfg.courierPay || {}),
            zones: Array.isArray(body.cfg && body.cfg.courierPay && body.cfg.courierPay.zones) ? body.cfg.courierPay.zones : current.cfg.courierPay.zones
          },
          // v73.1: prioridade das impressoras/vias
          stationOrder: Array.isArray(body.cfg && body.cfg.stationOrder) ? body.cfg.stationOrder : current.cfg.stationOrder
        },
        menu: normalizeMenu(menuBeforeNormalize, validStationKeys, (body.cfg && body.cfg.defaultStation) || current.cfg.defaultStation)
      };
      writeJSON(CONFIG_FILE, merged);
      broadcast('config-updated', {});
      publicBroadcast('menu-updated', {});
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/change-password — troca senha do painel (admin) ou senha master ──
  if (pathname === '/api/change-password' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { which, current: curPass, next } = await readBody(req);
      const field = which === 'master' ? 'masterPass' : 'adminPass';
      const data = readConfig();
      if (curPass !== data.cfg[field]) return sendJSON(res, 403, { error: 'senha atual incorreta' });
      if (!next || next.length < 4) return sendJSON(res, 400, { error: 'nova senha muito curta (mín. 4 caracteres)' });
      data.cfg[field] = next;
      writeJSON(CONFIG_FILE, data);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── Gerenciamento de usuários do painel (só o usuário master pode mexer) ──
  // ── GET /api/admin/customer-lookup?phone=... — v47: usado pela tela de Novo Pedido Manual
  // pra preencher nome/endereço/CEP sozinho quando o telefone já é de um cliente conhecido, sem
  // precisar redigitar tudo de novo. Primeiro tenta o cadastro (customers.json); se o cliente
  // nunca criou conta mas já tem pedido anterior, usa os dados do pedido mais recente dele. ──
  if (pathname === '/api/admin/customer-lookup' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'clientes', 'ver')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const phone = normalizePhone(query.phone || '');
    if (!phone) return sendJSON(res, 200, { found: false });
    const customers = readJSON(CUSTOMERS_FILE);
    const cust = findCustomer(customers, phone);
    const orders = readJSON(ORDERS_FILE).filter(o => normalizePhone(o.phone) === phone).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const lastOrder = orders[0];
    if (!cust && !lastOrder) return sendJSON(res, 200, { found: false });
    return sendJSON(res, 200, {
      found: true,
      name: (cust && cust.name) || (lastOrder && lastOrder.name) || '',
      address: (cust && cust.lastAddress) || (lastOrder && lastOrder.mode === 'delivery' ? lastOrder.address : '') || '',
      ordersCount: orders.length
    });
  }

  // ── GET /api/admin/customers — lista clientes cadastrados com estatísticas (painel, promoções por SMS) ──
  if (pathname === '/api/admin/customers' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'clientes', 'ver')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver os clientes.' });
    const { cfg } = readConfig();
    const customers = readJSON(CUSTOMERS_FILE);
    const orders = readJSON(ORDERS_FILE);
    const list = customers.map(c => ({
      phone: c.phone, name: c.name, createdAt: c.createdAt, lastAddress: c.lastAddress,
      hasPendingRecovery: !!(c.recovery && !c.recovery.approved),
      ...customerStats(c.phone, orders),
      loyaltyPoints: loyaltyBalance(c.phone, orders, cfg).balance
    })).sort((a, b) => b.orderCount - a.orderCount);
    return sendJSON(res, 200, { customers: list });
  }


  if (pathname === '/api/admin/send-promo-sms' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'enviar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra enviar SMS.' });
    try {
      const { phones, message } = await readBody(req);
      const { cfg } = readConfig();
      const msg = String(message || '').slice(0, 300).trim();
      if (!msg) return sendJSON(res, 400, { error: 'Digite a mensagem.' });
      const list = Array.isArray(phones) ? phones.slice(0, 200) : [];
      if (!list.length) return sendJSON(res, 400, { error: 'Selecione pelo menos um cliente.' });
      const results = { sent: 0, failed: 0, errors: [] };
      for (const phone of list) {
        try { await sendSMS(phone, msg, cfg.sms); results.sent++; }
        catch (e) { results.failed++; if (results.errors.length < 3) results.errors.push(e.message); }
      }
      return sendJSON(res, 200, { ok: true, ...results });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── Contatos importados (v56) — CSV do Google/Outlook, vCard (.vcf) ou bloco de notas (.txt).
  // Fica num arquivo separado de customers.json de propósito: customers.json é gerado sozinho a
  // partir de pedidos reais, e não deve ser misturado com uma lista externa que ninguém confirmou
  // que já comprou algo. Serve pra ampliar o alcance de campanhas de SMS/promoção por região (DDD).
  function extrairDDD(telefone) {
    let d = String(telefone || '').replace(/\D/g, '');
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
    return d.length >= 10 ? d.slice(0, 2) : '??';
  }
  if (pathname === '/api/admin/contatos' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'clientes', 'ver')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const lista = readJSON(CONTATOS_IMPORTADOS_FILE, []);
    return sendJSON(res, 200, { contatos: lista });
  }
  if (pathname === '/api/admin/contatos/importar' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'clientes', 'criar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const body = await readBody(req);
      const recebidos = Array.isArray(body.contatos) ? body.contatos.slice(0, 5000) : [];
      if (!recebidos.length) return sendJSON(res, 400, { error: 'Nenhum contato recebido.' });
      const lista = readJSON(CONTATOS_IMPORTADOS_FILE, []);
      const existentes = new Set(lista.map(c => c.telefone.replace(/\D/g, '')));
      let criados = 0;
      recebidos.forEach(c => {
        const telDigitos = String(c.telefone || '').replace(/\D/g, '');
        if (!telDigitos || telDigitos.length < 8 || existentes.has(telDigitos)) return;
        existentes.add(telDigitos);
        lista.push({
          id: crypto.randomBytes(8).toString('hex'),
          nome: String(c.nome || 'Sem nome').trim().slice(0, 120),
          telefone: telDigitos,
          ddd: extrairDDD(telDigitos),
          origem: String(body.origem || 'importação').slice(0, 40),
          importadoEm: new Date().toISOString()
        });
        criados++;
      });
      writeJSON(CONTATOS_IMPORTADOS_FILE, lista);
      return sendJSON(res, 200, { ok: true, criados, ignorados: recebidos.length - criados, total: lista.length });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  const contatoMatch = pathname.match(/^\/api\/admin\/contatos\/([^/]+)$/);
  if (contatoMatch && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'clientes', 'excluir')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    let lista = readJSON(CONTATOS_IMPORTADOS_FILE, []);
    const antes = lista.length;
    lista = lista.filter(c => c.id !== contatoMatch[1]);
    writeJSON(CONTATOS_IMPORTADOS_FILE, lista);
    return sendJSON(res, 200, { removido: antes !== lista.length });
  }

  // ── IA de atendimento (v57) ──
  // GET/POST /api/ia/settings — nunca devolve a chave de API crua (só se está preenchida ou não),
  // do mesmo jeito que senhas nunca voltam pro painel. Ficam fora do fluxo normal de /api/config
  // de propósito, pra a chave nunca correr o risco de ser reenviada em branco num "Salvar Tudo".
  if (pathname === '/api/ia/settings' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'sistema', 'configuracoesAvancadas')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const { cfg } = readConfig();
    return sendJSON(res, 200, {
      enabled: !!cfg.ia.enabled, hasKey: !!cfg.ia.apiKey, provider: cfg.ia.provider || 'groq',
      modelo: cfg.ia.modelo || '', faq: cfg.ia.faq || [], provedores: IA_PROVEDORES,
      badgesAutoAprovar: !!cfg.ia.badgesAutoAprovar,
      // v98 — AI ROUTER
      modeloVisao: cfg.ia.modeloVisao || '',
      fallbackAutomatico: cfg.ia.fallbackAutomatico !== false,
      modoBasico: cfg.ia.modoBasico !== false,
      hasGeminiEnvKey: !!process.env.GEMINI_API_KEY,
      status: calcularStatusIA(cfg.ia)
    });
  }
  if (pathname === '/api/ia/settings' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'sistema', 'configuracoesAvancadas')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const body = await readBody(req);
      const data = readConfig();
      const iaAtual = data.cfg.ia || {};
      data.cfg.ia = {
        enabled: !!body.enabled,
        provider: IA_PROVEDORES[body.provider] ? body.provider : (iaAtual.provider || 'groq'),
        apiKey: (typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : iaAtual.apiKey || '',
        modelo: typeof body.modelo === 'string' ? body.modelo.trim() : (iaAtual.modelo || ''),
        faq: Array.isArray(body.faq) ? body.faq.slice(0, 100).map(f => ({ pergunta: String(f.pergunta || '').slice(0, 200), resposta: String(f.resposta || '').slice(0, 600) })).filter(f => f.pergunta && f.resposta) : (iaAtual.faq || []),
        badgesAutoAprovar: body.badgesAutoAprovar !== undefined ? !!body.badgesAutoAprovar : !!iaAtual.badgesAutoAprovar,
        // v98 — AI ROUTER
        modeloVisao: typeof body.modeloVisao === 'string' ? body.modeloVisao.trim() : (iaAtual.modeloVisao || ''),
        fallbackAutomatico: body.fallbackAutomatico !== undefined ? !!body.fallbackAutomatico : (iaAtual.fallbackAutomatico !== false),
        modoBasico: body.modoBasico !== undefined ? !!body.modoBasico : (iaAtual.modoBasico !== false)
      };
      writeJSON(CONFIG_FILE, { cfg: data.cfg, menu: data.menu });
      return sendJSON(res, 200, { ok: true, enabled: data.cfg.ia.enabled, hasKey: !!data.cfg.ia.apiKey, badgesAutoAprovar: data.cfg.ia.badgesAutoAprovar });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // POST /api/custos/ler-imagem — lê foto de nota fiscal (custo) ou catálogo (preço de venda) e
  // devolve uma lista pra o admin CONFERIR antes de salvar (não grava nada sozinho).
  if (pathname === '/api/custos/ler-imagem' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { imagemBase64, mediaType, tipo } = await readBody(req, 15e6);
      if (!imagemBase64) return sendJSON(res, 400, { error: 'Nenhuma imagem recebida.' });
      const { cfg } = readConfig();
      const itens = await lerImagemIA(imagemBase64, mediaType, tipo, cfg.ia);
      return sendJSON(res, 200, { itens });
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Não consegui ler essa imagem.' }); }
  }
  // v98 — POST /api/custos/ler-nota-fiscal — leitura ESTRUTURADA (fornecedor/CNPJ/número/série/
  // data/produtos com código-quantidade-unidade-preço) — aditivo, não substitui /ler-imagem acima.
  if (pathname === '/api/custos/ler-nota-fiscal' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { imagemBase64, mediaType } = await readBody(req, 15e6);
      if (!imagemBase64) return sendJSON(res, 400, { error: 'Nenhuma imagem recebida.' });
      const { cfg } = readConfig();
      const nota = await lerNotaFiscalEstruturadaIA(imagemBase64, mediaType, cfg.ia);
      return sendJSON(res, 200, { nota });
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Não consegui ler essa nota fiscal.' }); }
  }

  // ── Atendimento — conversas (v57) ── janela de chat do cliente, estilo WhatsApp: começa com a
  // IA (se configurada) e o cliente pode pedir "falar com atendente" a qualquer momento, o que
  // marca a conversa pra aparecer no painel (Configurações → Atendimento) pro caixa responder na
  // mão. Tudo público do lado do cliente (não exige login), autenticado do lado do painel.
  function lerAtendimentos() { return readJSON(ATENDIMENTO_FILE); }
  function salvarAtendimentos(obj) { writeJSON(ATENDIMENTO_FILE, obj); }

  if (pathname === '/api/atendimento/iniciar' && req.method === 'POST') {
    const { cfg } = readConfig();
    const todas = lerAtendimentos();
    // v70: se o cliente já tem cadastro (pediu antes / fez login no cardápio), o nome/telefone
    // dele vêm no corpo — assim o atendente já vê o nome de verdade na lista de conversas, em
    // vez do genérico "Cliente XXXXX". Cliente anônimo (sem cadastro) manda vazio, sem problema.
    let nome = '', telefone = '';
    try { const body = await readBody(req, 2000); nome = String(body.nome || '').trim().slice(0, 80); telefone = String(body.telefone || '').trim().slice(0, 30); } catch (e) {}
    // v70: se o ATENDENTE já iniciou uma conversa com esse telefone antes do cliente aparecer
    // (ver /api/admin/atendimento/nova), reaproveita ela agora — assim a mensagem que o
    // restaurante mandou primeiro já aparece esperando o cliente, em vez de nascer uma conversa
    // vazia separada. Só entra aqui se o cliente informou telefone (tem cadastro).
    if (telefone) {
      const telNorm = normalizePhone(telefone);
      const existente = Object.values(todas).find(c => c.criadaPorAtendente && normalizePhone(c.telefoneCliente || '') === telNorm && !c.adotadaPeloCliente);
      if (existente) {
        existente.adotadaPeloCliente = true;
        existente.ultimaAtividade = new Date().toISOString();
        salvarAtendimentos(todas);
        return sendJSON(res, 200, { conversaId: existente.id, modo: existente.modo });
      }
    }
    const id = crypto.randomBytes(10).toString('hex');
    todas[id] = {
      id, criadaEm: new Date().toISOString(), ultimaAtividade: new Date().toISOString(),
      modo: (cfg.ia && cfg.ia.enabled) ? 'ia' : 'humano', naoLidaAtendente: false, mensagens: [],
      nomeCliente: nome, telefoneCliente: telefone
    };
    salvarAtendimentos(todas);
    return sendJSON(res, 200, { conversaId: id, modo: todas[id].modo });
  }
  const conversaGetMatch = pathname.match(/^\/api\/atendimento\/([a-f0-9]+)$/);
  if (conversaGetMatch && req.method === 'GET') {
    const todas = lerAtendimentos();
    const conversa = todas[conversaGetMatch[1]];
    if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
    return sendJSON(res, 200, { conversa });
  }
  // ── POST /api/atendimento/:id/upload — anexo (foto ou áudio) do CHAT DO CLIENTE (v60) ──
  // Rota própria e pública (sem checkAuth) porque quem manda é o cliente, sem login — diferente
  // de /api/upload (exige admin, usado no cardápio/ingredientes/etc). Só aceita se a conversa
  // já existir de verdade (mesma proteção fraca que as outras rotas públicas de atendimento já
  // usam, baseada em conhecer o id aleatório de 20 caracteres da conversa) e com limites de
  // tamanho menores, pra reduzir o risco de abuso por não exigir login.
  const conversaUploadMatch = pathname.match(/^\/api\/atendimento\/([a-f0-9]+)\/upload$/);
  if (conversaUploadMatch && req.method === 'POST') {
    try {
      const todas = lerAtendimentos();
      const conversa = todas[conversaUploadMatch[1]];
      if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
      const { dataUrl } = await readBody(req, 8e6);
      const mImg = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || '');
      const mAudio = /^data:audio\/(webm|ogg|mpeg|mp3|mp4|m4a)(?:;codecs=[a-z0-9.]+)?;base64,(.+)$/i.exec(dataUrl || '');
      if (!mImg && !mAudio) return sendJSON(res, 400, { error: 'Formato inválido. Use foto (PNG/JPG/WEBP) ou áudio.' });
      const m = mImg || mAudio;
      let ext = m[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg'; else if (ext === 'mpeg') ext = 'mp3';
      const buffer = Buffer.from(m[2], 'base64');
      // v61: limite de foto subiu de 3MB pra 5MB (pedido explícito), pra reduzir os casos de
      // "foto grande demais" recusada — o áudio continua em 5MB (já era suficiente).
      const maxBytes = 5 * 1024 * 1024;
      if (buffer.length > maxBytes) return sendJSON(res, 400, { error: mAudio ? 'Áudio muito grande (máx. 5MB, tente uma mensagem mais curta).' : 'Foto muito grande (máx. 5MB).' });
      const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
      if (mImg) syncUploadToSupabase(filename, buffer, ext);
      return sendJSON(res, 200, { url: '/uploads/' + filename, tipo: mImg ? 'imagem' : 'audio' });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  const conversaMsgMatch = pathname.match(/^\/api\/atendimento\/([a-f0-9]+)\/mensagem$/);
  if (conversaMsgMatch && req.method === 'POST') {
    try {
      const { texto, tipo, url } = await readBody(req);
      // v60: mensagens agora podem ser foto/áudio, não só texto — 'tipo' vem de POST .../upload
      // (feito antes, pra já ter a URL do arquivo em mãos na hora de mandar a mensagem).
      const tipoFinal = (tipo === 'imagem' || tipo === 'audio') ? tipo : 'texto';
      const t = String(texto || '').trim().slice(0, 500);
      if (tipoFinal === 'texto' && !t) return sendJSON(res, 400, { error: 'Escreva uma mensagem.' });
      if (tipoFinal !== 'texto' && !url) return sendJSON(res, 400, { error: 'Anexo sem URL.' });
      const todas = lerAtendimentos();
      const conversa = todas[conversaMsgMatch[1]];
      if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
      const msg = { de: 'cliente', texto: t, ts: new Date().toISOString() };
      if (tipoFinal !== 'texto') { msg.tipo = tipoFinal; msg.url = String(url).slice(0, 300); }
      conversa.mensagens.push(msg);
      conversa.ultimaAtividade = new Date().toISOString();
      conversa.clienteDigitandoAte = 0; // já mandou — encerra o indicador de "digitando" na hora
      // v60: foto/áudio a IA não consegue interpretar — pula direto pro atendente humano em vez
      // de tentar responder chutando às cegas ou fingir que entendeu o anexo.
      if (conversa.modo === 'humano' || tipoFinal !== 'texto') {
        if (tipoFinal !== 'texto' && conversa.modo === 'ia') {
          conversa.mensagens.push({ de: 'sistema', texto: 'Anexo recebido — chamando um atendente pra ver.', ts: new Date().toISOString() });
        }
        conversa.naoLidaAtendente = true;
        salvarAtendimentos(todas);
        return sendJSON(res, 200, { conversa });
      }
      // modo IA
      const { cfg, menu } = readConfig();
      try {
        const resposta = await perguntarIA(conversa.mensagens, cfg.ia, cfg, menu);
        conversa.mensagens.push({ de: 'ia', texto: resposta || 'Não consegui pensar numa resposta agora — quer falar com um atendente?', ts: new Date().toISOString() });
      } catch (e) {
        // v98 — MODO BÁSICO: em vez de só um aviso genérico, tenta uma resposta local útil quando
        // ativado (padrão: ligado). Nunca inventa informação — só orienta com o que o sistema já
        // sabe de verdade (cardápio/config) e sempre oferece "falar com atendente".
        const texto = (cfg.ia && cfg.ia.modoBasico !== false)
          ? respostaModoBasico(conversa.mensagens, cfg)
          : 'No momento não consigo responder automaticamente. Toque em "Falar com atendente" que alguém te responde.';
        conversa.mensagens.push({ de: 'ia', texto, ts: new Date().toISOString() });
      }
      salvarAtendimentos(todas);
      return sendJSON(res, 200, { conversa });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/atendimento/:id/digitando — indicador de "digitando..." (v60) ──
  // Chamado pelo navegador do cliente enquanto ele digita (com um intervalo mínimo entre
  // chamadas, ver index.html) — só marca um timestamp; quem lê (o painel, no polling que já
  // existia) considera "digitando" só se esse timestamp for de poucos segundos atrás.
  const conversaDigitandoMatch = pathname.match(/^\/api\/atendimento\/([a-f0-9]+)\/digitando$/);
  if (conversaDigitandoMatch && req.method === 'POST') {
    const todas = lerAtendimentos();
    const conversa = todas[conversaDigitandoMatch[1]];
    if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
    conversa.clienteDigitandoAte = Date.now() + 4000;
    salvarAtendimentos(todas);
    return sendJSON(res, 200, { ok: true });
  }
  const conversaHumanoMatch = pathname.match(/^\/api\/atendimento\/([a-f0-9]+)\/humano$/);
  if (conversaHumanoMatch && req.method === 'POST') {
    const todas = lerAtendimentos();
    const conversa = todas[conversaHumanoMatch[1]];
    if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
    conversa.modo = 'humano';
    conversa.naoLidaAtendente = true;
    conversa.mensagens.push({ de: 'sistema', texto: 'Cliente pediu pra falar com um atendente.', ts: new Date().toISOString() });
    conversa.ultimaAtividade = new Date().toISOString();
    salvarAtendimentos(todas);
    // v80: mesmo alerta push simultâneo (PC + celular, mesmo com o painel/app fechado) que já
    // avisa pedido novo e reserva nova — agora também dispara quando um cliente pede pra falar
    // com um atendente humano, pra quem for chamado saber na hora, numa tela, mesmo de longe.
    sendAdminPush({
      title: '🙋 Cliente chamando atendente!',
      body: `${conversa.nomeCliente || 'Um cliente'} está esperando atendimento humano no Chat Express.`,
      url: '/painel.html',
      icon: '/icon-192.png',
      sound: 'oriental',
      tag: 'shogatsu-atendimento-humano-' + conversaHumanoMatch[1]
    });
    return sendJSON(res, 200, { conversa });
  }
  // Painel — listar e responder conversas
  if (pathname === '/api/admin/atendimento' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const todas = lerAtendimentos();
    const lista = Object.values(todas)
      .filter(c => c.mensagens.length > 0)
      .sort((a, b) => new Date(b.ultimaAtividade) - new Date(a.ultimaAtividade))
      .slice(0, 200);
    return sendJSON(res, 200, { conversas: lista });
  }
  // ── POST /api/admin/atendimento/nova (v70) — atendente inicia uma conversa com um cliente já
  // cadastrado (achado via /api/admin/customers), sem esperar o cliente escrever primeiro. Fica
  // esperando: se esse cliente abrir o Chat Express depois usando o mesmo telefone, cai direto
  // nessa mesma conversa (ver /api/atendimento/iniciar) e já vê a mensagem esperando ele. ──
  if (pathname === '/api/admin/atendimento/nova' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { nome, telefone, mensagem } = await readBody(req);
      const tel = String(telefone || '').trim();
      const msg = String(mensagem || '').trim().slice(0, 1000);
      if (!tel) return sendJSON(res, 400, { error: 'Escolha um cliente com telefone cadastrado.' });
      if (!msg) return sendJSON(res, 400, { error: 'Escreva a mensagem inicial.' });
      const todas = lerAtendimentos();
      const telNorm = normalizePhone(tel);
      // já existe uma conversa em aberto com esse telefone? reaproveita em vez de duplicar
      const existente = Object.values(todas).find(c => normalizePhone(c.telefoneCliente || '') === telNorm);
      const conversa = existente || (() => {
        const id = crypto.randomBytes(10).toString('hex');
        todas[id] = {
          id, criadaEm: new Date().toISOString(), modo: 'humano', naoLidaAtendente: false, mensagens: [],
          nomeCliente: String(nome || '').trim().slice(0, 80), telefoneCliente: tel,
          criadaPorAtendente: true, adotadaPeloCliente: false
        };
        return todas[id];
      })();
      conversa.modo = 'humano';
      conversa.mensagens.push({ de: 'atendente', texto: msg, ts: new Date().toISOString() });
      conversa.ultimaAtividade = new Date().toISOString();
      salvarAtendimentos(todas);
      return sendJSON(res, 200, { ok: true, conversa });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── DELETE /api/admin/atendimento/:id (v70) — apaga o histórico de uma conversa por completo.
  // Ação sem volta — o cliente, se reabrir o chat com o mesmo id salvo, vai simplesmente começar
  // uma conversa nova do zero (o servidor responde 404 pra esse id antigo). ──
  const conversaDeleteMatch = pathname.match(/^\/api\/admin\/atendimento\/([a-f0-9]+)$/);
  if (conversaDeleteMatch && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'sistema', 'configuracoesAvancadas')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra excluir conversas.' });
    const todas = lerAtendimentos();
    if (!todas[conversaDeleteMatch[1]]) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
    delete todas[conversaDeleteMatch[1]];
    salvarAtendimentos(todas);
    return sendJSON(res, 200, { ok: true });
  }
  const conversaResponderMatch = pathname.match(/^\/api\/admin\/atendimento\/([a-f0-9]+)\/responder$/);
  if (conversaResponderMatch && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { texto, tipo, url } = await readBody(req);
      const tipoFinal = (tipo === 'imagem' || tipo === 'audio') ? tipo : 'texto';
      const t = String(texto || '').trim().slice(0, 1000);
      if (tipoFinal === 'texto' && !t) return sendJSON(res, 400, { error: 'Escreva uma resposta.' });
      const todas = lerAtendimentos();
      const conversa = todas[conversaResponderMatch[1]];
      if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
      conversa.modo = 'humano';
      conversa.naoLidaAtendente = false;
      conversa.atendenteDigitandoAte = 0;
      const msg = { de: 'atendente', texto: t, ts: new Date().toISOString() };
      if (tipoFinal !== 'texto') { msg.tipo = tipoFinal; msg.url = String(url || '').slice(0, 300); }
      conversa.mensagens.push(msg);
      conversa.ultimaAtividade = new Date().toISOString();
      salvarAtendimentos(todas);
      return sendJSON(res, 200, { conversa });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/admin/atendimento/:id/digitando — indicador de "digitando..." do lado do
  // atendente (v60), espelho da rota pública equivalente do cliente. ──
  const conversaAdminDigitandoMatch = pathname.match(/^\/api\/admin\/atendimento\/([a-f0-9]+)\/digitando$/);
  if (conversaAdminDigitandoMatch && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const todas = lerAtendimentos();
    const conversa = todas[conversaAdminDigitandoMatch[1]];
    if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
    conversa.atendenteDigitandoAte = Date.now() + 4000;
    salvarAtendimentos(todas);
    return sendJSON(res, 200, { ok: true });
  }
  // ── POST /api/admin/atendimento/:id/upload — anexo (foto/áudio) do atendente, do painel (v60) ──
  const conversaAdminUploadMatch = pathname.match(/^\/api\/admin\/atendimento\/([a-f0-9]+)\/upload$/);
  if (conversaAdminUploadMatch && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const todas = lerAtendimentos();
      const conversa = todas[conversaAdminUploadMatch[1]];
      if (!conversa) return sendJSON(res, 404, { error: 'Conversa não encontrada.' });
      const { dataUrl } = await readBody(req, 8e6);
      const mImg = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || '');
      const mAudio = /^data:audio\/(webm|ogg|mpeg|mp3|mp4|m4a)(?:;codecs=[a-z0-9.]+)?;base64,(.+)$/i.exec(dataUrl || '');
      if (!mImg && !mAudio) return sendJSON(res, 400, { error: 'Formato inválido. Use foto (PNG/JPG/WEBP) ou áudio.' });
      const m = mImg || mAudio;
      let ext = m[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg'; else if (ext === 'mpeg') ext = 'mp3';
      const buffer = Buffer.from(m[2], 'base64');
      // v61: limite de foto do painel subiu de 4MB pra 5MB (pedido explícito)
      const maxBytes = mAudio ? 6 * 1024 * 1024 : 5 * 1024 * 1024;
      if (buffer.length > maxBytes) return sendJSON(res, 400, { error: mAudio ? 'Áudio muito grande (máx. 6MB).' : 'Foto muito grande (máx. 5MB).' });
      const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
      if (mImg) syncUploadToSupabase(filename, buffer, ext);
      return sendJSON(res, 200, { url: '/uploads/' + filename, tipo: mImg ? 'imagem' : 'audio' });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }


  // v109: GET /api/admin/users agora devolve também active/permissions (só quem tem
  // 'usuarios'.'ver' - master sempre tem). Senha (hash) nunca é incluída na resposta.
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!canManageUsers(getSession(getToken(req, query)), 'ver')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver os usuários.' });
    const { cfg } = readConfig();
    return sendJSON(res, 200, { users: (cfg.users || []).map(u => ({ username: u.username, displayName: u.displayName || '', role: u.role, active: u.active !== false, permissions: u.permissions || null })) });
  }
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    const actingSession = getSession(getToken(req, query));
    const action = 'criar'; // POST cobre criação e edição — a checagem específica de "editar" roda abaixo, se for o caso
    if (!canManageUsers(actingSession, action) && !canManageUsers(actingSession, 'editar')) {
      return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra gerenciar usuários.' });
    }
    try {
      const { username, password, role, permissions, displayName } = await readBody(req);
      const uname = String(username || '').trim().toLowerCase();
      if (!uname || uname.length < 3) return sendJSON(res, 400, { error: 'Usuário precisa ter pelo menos 3 caracteres.' });
      if (!ALL_ROLES.includes(role)) return sendJSON(res, 400, { error: 'Nível de acesso inválido.' });
      const data = readConfig();
      const existing = data.cfg.users.find(u => String(u.username || '').toLowerCase() === uname);
      const cleanPerms = sanitizePermissions(permissions);
      const guardMsg = guardUserMutation(actingSession, existing, role, cleanPerms);
      if (guardMsg) return sendJSON(res, 403, { error: guardMsg });
      const before = existing ? JSON.parse(JSON.stringify(existing.permissions || {})) : {};
      if (existing) {
        if (!canManageUsers(actingSession, 'editar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra editar usuários.' });
        existing.role = role;
        if (displayName !== undefined) existing.displayName = String(displayName || '').trim().slice(0, 60);
        if (password) {
          if (!canManageUsers(actingSession, 'alterarSenhas')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra alterar senhas.' });
          existing.passwordHash = hashUserPassword(uname, password); delete existing.password;
        }
        if (cleanPerms !== undefined) existing.permissions = cleanPerms;
      } else {
        if (!canManageUsers(actingSession, 'criar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra criar usuários.' });
        if (!password || password.length < 4) return sendJSON(res, 400, { error: 'Senha precisa ter pelo menos 4 caracteres.' });
        data.cfg.users.push({ username: uname, displayName: String(displayName || '').trim().slice(0, 60), passwordHash: hashUserPassword(uname, password), role, active: true, permissions: cleanPerms || undefined });
      }
      writeJSON(CONFIG_FILE, data);
      const after = existing ? existing.permissions || {} : (cleanPerms || {});
      const { added, removed } = diffPermissions(before, after);
      if (added.length || removed.length || !existing) {
        logPermissionChange(actingSession.username, uname, existing ? { added, removed } : { criado: true, role });
      }
      return sendJSON(res, 200, { ok: true, users: data.cfg.users.map(u => ({ username: u.username, displayName: u.displayName || '', role: u.role, active: u.active !== false, permissions: u.permissions || null })) });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // v109: PATCH /api/admin/users/:username/permissions — edita SÓ as permissões (sem mexer em
  // senha/role), com todas as travas de segurança do item 25/31 do escopo (ninguém concede o
  // que não tem, master é intocável por terceiros, ninguém mexe na própria permissão).
  if (pathname.match(/^\/api\/admin\/users\/[^/]+\/permissions$/) && req.method === 'PATCH') {
    const actingSession = getSession(getToken(req, query));
    if (!canManageUsers(actingSession, 'gerenciarPermissoes')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra gerenciar permissões.' });
    const uname = decodeURIComponent(pathname.split('/')[4] || '').toLowerCase();
    try {
      const { permissions } = await readBody(req);
      const cleanPerms = sanitizePermissions(permissions) || {};
      const data = readConfig();
      const target = data.cfg.users.find(u => String(u.username || '').toLowerCase() === uname);
      if (!target) return sendJSON(res, 404, { error: 'Usuário não encontrado.' });
      const guardMsg = guardUserMutation(actingSession, target, target.role, cleanPerms);
      if (guardMsg) return sendJSON(res, 403, { error: guardMsg });
      const before = JSON.parse(JSON.stringify(target.permissions || {}));
      target.permissions = cleanPerms;
      writeJSON(CONFIG_FILE, data);
      const { added, removed } = diffPermissions(before, cleanPerms);
      logPermissionChange(actingSession.username, uname, { added, removed });
      return sendJSON(res, 200, { ok: true, permissions: target.permissions, added, removed });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // v109: POST /api/admin/users/:username/active — ativa/desativa um login (item 19 "Status" +
  // item 30 "usuário desativado → login bloqueado"). Usuário desativado não passa mais no login
  // (ver POST /api/login) e hasPermission() nega tudo pra ele mesmo com token antigo ainda válido.
  if (pathname.match(/^\/api\/admin\/users\/[^/]+\/active$/) && req.method === 'POST') {
    const actingSession = getSession(getToken(req, query));
    if (!canManageUsers(actingSession, 'desativar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ativar/desativar usuários.' });
    const uname = decodeURIComponent(pathname.split('/')[4] || '').toLowerCase();
    try {
      const { active } = await readBody(req);
      const data = readConfig();
      const target = data.cfg.users.find(u => String(u.username || '').toLowerCase() === uname);
      if (!target) return sendJSON(res, 404, { error: 'Usuário não encontrado.' });
      const guardMsg = guardUserMutation(actingSession, target, target.role, null);
      if (guardMsg) return sendJSON(res, 403, { error: guardMsg });
      if (target.role === 'master' && active === false) return sendJSON(res, 400, { error: 'Não dá pra desativar um usuário master.' });
      target.active = !!active;
      writeJSON(CONFIG_FILE, data);
      logPermissionChange(actingSession.username, uname, active ? { reativado: true } : { desativado: true });
      return sendJSON(res, 200, { ok: true, active: target.active });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const actingSession = getSession(getToken(req, query));
    if (!canManageUsers(actingSession, 'desativar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra remover usuários.' });
    const uname = decodeURIComponent(pathname.split('/').pop() || '').toLowerCase();
    const data = readConfig();
    const target = data.cfg.users.find(u => String(u.username || '').toLowerCase() === uname);
    if (!target) return sendJSON(res, 404, { error: 'Usuário não encontrado.' });
    const guardMsg = guardUserMutation(actingSession, target, target.role, null);
    if (guardMsg) return sendJSON(res, 403, { error: guardMsg });
    if (target.role === 'master' && data.cfg.users.filter(u => u.role === 'master').length <= 1) {
      return sendJSON(res, 400, { error: 'Precisa existir pelo menos um usuário master.' });
    }
    data.cfg.users = data.cfg.users.filter(u => String(u.username || '').toLowerCase() !== uname);
    writeJSON(CONFIG_FILE, data);
    logPermissionChange(actingSession.username, uname, { removido: true });
    return sendJSON(res, 200, { ok: true });
  }
  // v109: GET /api/admin/permission-catalog — catálogo de categorias/ações (é a partir daqui
  // que o painel desenha as caixinhas; nunca fica hardcoded duas vezes/dessincronizado).
  if (pathname === '/api/admin/permission-catalog' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, { catalog: PERMISSION_CATALOG, roles: ALL_ROLES, templates: DEFAULT_PERMISSION_TEMPLATES });
  }
  // v109: GET /api/admin/permission-log — histórico de alterações (item 29). Só quem gerencia
  // usuários enxerga (nunca inclui senha, só quem/o quê/quando).
  if (pathname === '/api/admin/permission-log' && req.method === 'GET') {
    if (!canManageUsers(getSession(getToken(req, query)), 'ver')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    return sendJSON(res, 200, { log: readJSON(PERMISSION_LOG_FILE).slice(0, 200) });
  }

  // ═══════════════════════════════════════════════════════════
  // MOTOBOYS (v32) — pré-cadastro de entregadores, pra agilizar a hora de
  // marcar "saiu para entrega" sem precisar digitar o nome toda vez.
  // ═══════════════════════════════════════════════════════════
  // ── GET /api/admin/couriers — lista motoboys cadastrados ──
  if (pathname === '/api/admin/couriers' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarSetores')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver os motoboys.' });
    return sendJSON(res, 200, { couriers: readJSON(COURIERS_FILE) });
  }
  // ── POST /api/admin/couriers — cadastra um novo motoboy ──
  if (pathname === '/api/admin/couriers' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarSetores')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra cadastrar motoboys.' });
    try {
      const { name, phone, plate, notes, photo } = await readBody(req);
      const nm = String(name || '').trim();
      if (!nm || nm.length < 2) return sendJSON(res, 400, { error: 'Digite o nome do motoboy.' });
      const couriers = readJSON(COURIERS_FILE);
      const courier = {
        id: 'MB' + Date.now().toString(36).toUpperCase(),
        name: nm,
        phone: String(phone || '').replace(/\D/g, ''),
        plate: String(plate || '').trim().toUpperCase(),
        notes: String(notes || '').trim().slice(0, 200),
        photo: String(photo || '').trim(), // v50: foto do motoboy (upload via /api/upload)
        active: true,
        createdAt: new Date().toISOString()
      };
      couriers.unshift(courier);
      writeJSON(COURIERS_FILE, couriers);
      return sendJSON(res, 201, { ok: true, courier, couriers });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── PATCH /api/admin/couriers/:id — edita dados ou ativa/desativa um motoboy ──
  if (pathname.match(/^\/api\/admin\/couriers\/[^/]+$/) && req.method === 'PATCH') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarSetores')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra editar motoboys.' });
    try {
      const id = decodeURIComponent(pathname.split('/').pop());
      const body = await readBody(req);
      const couriers = readJSON(COURIERS_FILE);
      const courier = couriers.find(c => c.id === id);
      if (!courier) return sendJSON(res, 404, { error: 'Motoboy não encontrado.' });
      if (body.name !== undefined) courier.name = String(body.name).trim();
      if (body.phone !== undefined) courier.phone = String(body.phone).replace(/\D/g, '');
      if (body.plate !== undefined) courier.plate = String(body.plate).trim().toUpperCase();
      if (body.notes !== undefined) courier.notes = String(body.notes).trim().slice(0, 200);
      if (body.photo !== undefined) courier.photo = String(body.photo).trim(); // v50
      if (body.active !== undefined) courier.active = !!body.active;
      writeJSON(COURIERS_FILE, couriers);
      return sendJSON(res, 200, { ok: true, courier, couriers });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── DELETE /api/admin/couriers/:id — remove um motoboy do cadastro ──
  if (pathname.match(/^\/api\/admin\/couriers\/[^/]+$/) && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarSetores')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra remover motoboys.' });
    const id = decodeURIComponent(pathname.split('/').pop());
    let couriers = readJSON(COURIERS_FILE);
    const existed = couriers.some(c => c.id === id);
    if (!existed) return sendJSON(res, 404, { error: 'Motoboy não encontrado.' });
    couriers = couriers.filter(c => c.id !== id);
    writeJSON(COURIERS_FILE, couriers);
    return sendJSON(res, 200, { ok: true, couriers });
  }


  if (pathname === '/api/upload' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { dataUrl } = await readBody(req, 21e6);
      // v53: além de imagem, agora também aceita vídeo curto — usado nas "Live Photo" da
      // Splash Screen (foto "viva" tocando em loop, mudo). Vídeo tem um limite maior (15MB)
      // porque pesa naturalmente mais que uma foto comprimida.
      const mImg = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || '');
      const mVideo = /^data:video\/(mp4|webm|quicktime);base64,(.+)$/i.exec(dataUrl || '');
      // v60: também aceita áudio — usado pelas mensagens de voz do módulo de Atendimento
      // (gravadas no navegador via MediaRecorder, formato webm/ogg/mp4 na maioria dos aparelhos).
      const mAudio = /^data:audio\/(webm|ogg|mpeg|mp3|mp4|m4a)(?:;codecs=[a-z0-9.]+)?;base64,(.+)$/i.exec(dataUrl || '');
      if (!mImg && !mVideo && !mAudio) return sendJSON(res, 400, { error: 'Formato inválido. Use PNG, JPG, WEBP (foto), MP4/WEBM/MOV (Live Photo) ou áudio (mensagem de voz).' });
      const m = mImg || mVideo || mAudio;
      let ext = m[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      else if (ext === 'quicktime') ext = 'mov';
      else if (ext === 'mpeg') ext = 'mp3';
      const buffer = Buffer.from(m[2], 'base64');
      const maxBytes = mVideo ? 15 * 1024 * 1024 : mAudio ? 6 * 1024 * 1024 : 4 * 1024 * 1024;
      if (buffer.length > maxBytes) return sendJSON(res, 400, { error: mVideo ? 'Vídeo muito grande (máx. 15MB).' : mAudio ? 'Áudio muito grande (máx. 6MB).' : 'Imagem muito grande (máx. 4MB).' });
      const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
      if (mImg) syncUploadToSupabase(filename, buffer, ext); // v60: só imagens fazem backup (vídeo é grande demais)
      return sendJSON(res, 200, { url: '/uploads/' + filename });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // v67 — FUNDO DO CHAT (Chat Express): Configurações → Aparência → Fundo do Chat.
  // Deixa o restaurante colocar uma foto de fundo nas conversas do chat que o cliente vê
  // (igual ao "papel de parede" do WhatsApp). Guarda tudo dentro de cfg.chatBackground —
  // sincroniza sozinho em qualquer aparelho porque já viaja junto no GET /api/config normal.
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/chat/background — devolve o fundo atual (não tem segredo nenhum aqui dentro,
  // então fica público — tanto o painel quanto o cardápio do cliente podem chamar direto).
  // v78: ?target=admin devolve o fundo do chat interno do painel; sem isso (ou target=client),
  // devolve o fundo do Chat Express que o cliente vê — são independentes. ──
  if (pathname === '/api/chat/background' && req.method === 'GET') {
    const { cfg } = readConfig();
    const key = query.target === 'admin' ? 'adminChatBackground' : 'chatBackground';
    return sendJSON(res, 200, { chatBackground: cfg[key] });
  }

  // ── POST /api/chat/background — envia uma foto nova, escolhe uma da galeria pronta, ou só
  // ativa/desativa e ajusta o escurecido sem trocar a imagem (manda só { enabled } / { overlay }). ──
  if (pathname === '/api/chat/background' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'editarInformacoes')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra alterar o fundo do chat.' });
    try {
      const { dataUrl, presetUrl, presetName, enabled, overlay, target } = await readBody(req, 8e6);
      const cfgKey = target === 'admin' ? 'adminChatBackground' : 'chatBackground';
      const current = readConfig();
      const prevBg = current.cfg[cfgKey] || DEFAULT_CFG[cfgKey];
      let next = { ...prevBg };

      if (dataUrl) {
        // Upload de imagem própria — só aceita PNG/JPG/WEBP, até 5MB (igual ao limite do card).
        const mImg = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
        if (!mImg) return sendJSON(res, 400, { error: 'Formato inválido. Use PNG, JPG ou WEBP.' });
        let ext = mImg[1].toLowerCase();
        if (ext === 'jpeg') ext = 'jpg';
        const buffer = Buffer.from(mImg[2], 'base64');
        if (buffer.length > 5 * 1024 * 1024) return sendJSON(res, 400, { error: 'Imagem muito grande (máx. 5MB).' });
        const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
        syncUploadToSupabase(filename, buffer, ext);
        // Se o fundo anterior era um upload nosso (não uma foto da galeria), apaga o arquivo
        // antigo do disco — senão fica lixo acumulando em uploads/ a cada troca de foto.
        if (prevBg.url && prevBg.url.startsWith('/uploads/')) {
          const oldPath = path.join(UPLOADS_DIR, prevBg.url.slice('/uploads/'.length));
          fs.unlink(oldPath, () => {}); // silencioso — se já não existir, tudo bem
        }
        const { width, height } = getImageDimensions(buffer, ext);
        next = {
          enabled: true, url: '/uploads/' + filename, name: 'Foto personalizada',
          size: buffer.length, width, height, date: new Date().toISOString(),
          overlay: (typeof prevBg.overlay === 'number') ? prevBg.overlay : 0.45
        };
      } else if (presetUrl) {
        // Escolheu uma foto pronta da galeria — não mexe em arquivo nenhum, só troca a URL.
        if (prevBg.url && prevBg.url.startsWith('/uploads/')) {
          const oldPath = path.join(UPLOADS_DIR, prevBg.url.slice('/uploads/'.length));
          fs.unlink(oldPath, () => {});
        }
        next = {
          enabled: true, url: String(presetUrl), name: String(presetName || 'Fundo da galeria'),
          size: 0, width: 0, height: 0, date: new Date().toISOString(),
          overlay: (typeof prevBg.overlay === 'number') ? prevBg.overlay : 0.45
        };
      }

      // { enabled } e/ou { overlay } podem vir junto (troca de imagem) ou sozinhos (só ligar/
      // desligar o fundo, ou só ajustar a opacidade do escurecido, sem mexer na foto).
      if (typeof enabled === 'boolean') next.enabled = enabled;
      if (typeof overlay === 'number' && overlay >= 0 && overlay <= 1) next.overlay = overlay;
      if (next.enabled && !next.url) return sendJSON(res, 400, { error: 'Envie uma imagem ou escolha uma da galeria antes de ativar.' });

      const merged = { cfg: { ...current.cfg, [cfgKey]: next }, menu: current.menu };
      writeJSON(CONFIG_FILE, merged);
      broadcast('config-updated', {});
      publicBroadcast('menu-updated', {}); // reaproveita o mesmo aviso que o cardápio já escuta pra recarregar config
      return sendJSON(res, 200, { ok: true, chatBackground: next });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── DELETE /api/chat/background — remove a foto e volta pro fundo padrão. ──
  if (pathname === '/api/chat/background' && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'editarInformacoes')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra alterar o fundo do chat.' });
    try {
      const cfgKey = query.target === 'admin' ? 'adminChatBackground' : 'chatBackground';
      const current = readConfig();
      const prevBg = current.cfg[cfgKey] || DEFAULT_CFG[cfgKey];
      if (prevBg.url && prevBg.url.startsWith('/uploads/')) {
        const oldPath = path.join(UPLOADS_DIR, prevBg.url.slice('/uploads/'.length));
        fs.unlink(oldPath, () => {});
      }
      const reset = { ...DEFAULT_CFG[cfgKey] };
      const merged = { cfg: { ...current.cfg, [cfgKey]: reset }, menu: current.menu };
      writeJSON(CONFIG_FILE, merged);
      broadcast('config-updated', {});
      publicBroadcast('menu-updated', {});
      return sendJSON(res, 200, { ok: true, chatBackground: reset });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/orders/purge — apaga pedidos antigos (exige senha master) ──
  if (pathname === '/api/orders/purge' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { masterPass, beforeDate } = await readBody(req);
      const data = readConfig();
      if (masterPass !== data.cfg.masterPass) return sendJSON(res, 403, { error: 'Senha master incorreta.' });
      if (!beforeDate) return sendJSON(res, 400, { error: 'Informe a data limite.' });
      const cutoff = new Date(beforeDate).getTime();
      let orders = readJSON(ORDERS_FILE);
      const before = orders.length;
      orders = orders.filter(o => new Date(o.createdAt).getTime() >= cutoff);
      writeJSON(ORDERS_FILE, orders);
      return sendJSON(res, 200, { ok: true, deleted: before - orders.length });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/reports — relatório de vendas (admin) ──
  if (pathname === '/api/reports' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const orders = readJSON(ORDERS_FILE);
    const from = query.from ? new Date(query.from + 'T00:00:00').getTime() : 0;
    const to = query.to ? new Date(query.to + 'T23:59:59').getTime() : Infinity;
    const filtered = orders.filter(o => {
      const t = new Date(o.createdAt).getTime();
      return t >= from && t <= to && o.status !== 'cancelado';
    });
    const totalOrders = filtered.length;
    const totalRevenue = filtered.reduce((s, o) => s + Number(o.total || 0), 0);
    const avgTicket = totalOrders ? totalRevenue / totalOrders : 0;
    const byPayMethod = {}, byDayMap = {}, itemsMap = {};
    filtered.forEach(o => {
      byPayMethod[o.payMethod] = (byPayMethod[o.payMethod] || 0) + Number(o.total || 0);
      const day = o.createdAt.slice(0, 10);
      if (!byDayMap[day]) byDayMap[day] = { date: day, revenue: 0, orders: 0 };
      byDayMap[day].revenue += Number(o.total || 0);
      byDayMap[day].orders++;
      (o.items || []).forEach(i => {
        if (!itemsMap[i.name]) itemsMap[i.name] = { name: i.name, qty: 0, revenue: 0 };
        itemsMap[i.name].qty += i.qty;
        itemsMap[i.name].revenue += i.price * i.qty;
      });
    });
    const topItems = Object.values(itemsMap).sort((a, b) => b.qty - a.qty).slice(0, 15);
    const byDay = Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date));
    return sendJSON(res, 200, { totalOrders, totalRevenue, avgTicket, byPayMethod, byDay, topItems });
  }

  // ── GET /api/admin/courier-report — v73: Relatório de Taxas de Motoboy ──
  // Calcula quanto pagar a cada entregador, contando entregas por bairro e valor devido, com
  // opção de ver todos juntos (somado) ou separado por motoboy. O valor devido por entrega usa
  // cfg.courierPay: 'fixo' (mesmo valor sempre) ou 'bairro' (valor configurado por bairro,
  // caindo pro valor fixo se o bairro da entrega não estiver cadastrado).
  // Query params: from, to (datas AAAA-MM-DD), courier ('' = todos).
  if (pathname === '/api/admin/courier-report' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'relatorios', 'ver')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver esse relatório.' });
    const { cfg } = readConfig();
    const orders = readJSON(ORDERS_FILE);
    const from = query.from ? new Date(query.from + 'T00:00:00').getTime() : 0;
    const to = query.to ? new Date(query.to + 'T23:59:59').getTime() : Infinity;
    const courierFilter = String(query.courier || '').trim();
    const pay = cfg.courierPay || { mode: 'fixo', fixedValue: 0, zones: [] };

    const valueForHood = (hood) => {
      if (pay.mode === 'bairro') {
        const match = matchBairroZone(hood, pay.zones);
        if (match) return Number(match.value) || 0;
      }
      return Number(pay.fixedValue) || 0;
    };

    const filtered = orders.filter(o => {
      const t = new Date(o.createdAt).getTime();
      if (t < from || t > to) return false;
      if (o.mode !== 'delivery') return false;                 // motoboy só entra em entregas, não em retirada
      if (o.status !== 'entregue') return false;                // só entregas concluídas contam pro pagamento
      if (!o.courierName) return false;                          // sem motoboy atribuído, não entra no relatório
      if (courierFilter && normalizeText(o.courierName) !== normalizeText(courierFilter)) return false;
      return true;
    });

    // ── Agrupado "Separado" — um bloco por motoboy, cada um com a quebra por bairro ──
    const byCourierMap = {};
    filtered.forEach(o => {
      const hood = o.hood || extractHoodFromAddress(o.address) || 'Não informado';
      const value = valueForHood(hood);
      if (!byCourierMap[o.courierName]) byCourierMap[o.courierName] = { courier: o.courierName, deliveries: 0, total: 0, byHood: {} };
      const c = byCourierMap[o.courierName];
      c.deliveries++;
      c.total += value;
      if (!c.byHood[hood]) c.byHood[hood] = { hood, deliveries: 0, unitValue: value, total: 0 };
      c.byHood[hood].deliveries++;
      c.byHood[hood].total += value;
    });
    const byCourier = Object.values(byCourierMap)
      .map(c => ({ ...c, byHood: Object.values(c.byHood).sort((a, b) => b.deliveries - a.deliveries) }))
      .sort((a, b) => b.total - a.total);

    // ── Agrupado "Juntos" — todos os motoboys somados, só a quebra por bairro ──
    const combinedByHoodMap = {};
    filtered.forEach(o => {
      const hood = o.hood || extractHoodFromAddress(o.address) || 'Não informado';
      const value = valueForHood(hood);
      if (!combinedByHoodMap[hood]) combinedByHoodMap[hood] = { hood, deliveries: 0, unitValue: value, total: 0 };
      combinedByHoodMap[hood].deliveries++;
      combinedByHoodMap[hood].total += value;
    });
    const combinedByHood = Object.values(combinedByHoodMap).sort((a, b) => b.deliveries - a.deliveries);

    // ── v73.1: lista pedido-a-pedido (Relatório Junto) — Pedido, Cliente, Bairro, Taxa, Data,
    // Horário, Status, Motoboy — pedida explicitamente na evolução v73 ──
    const rows = filtered
      .map(o => {
        const hood = o.hood || extractHoodFromAddress(o.address) || 'Não informado';
        const value = valueForHood(hood);
        const d = new Date(o.createdAt);
        return {
          orderLabel: o.ticketNumber ? ('#' + o.ticketNumber) : ('#' + String(o.id).slice(-6)),
          customer: o.name || 'Cliente',
          hood,
          value,
          date: d.toLocaleDateString('pt-BR'),
          time: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          status: o.status,
          courier: o.courierName,
          createdAt: o.createdAt
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalDeliveries = filtered.length;
    const totalValue = byCourier.reduce((s, c) => s + c.total, 0);
    // ── v73.1: estatísticas "Por valor" e "Por quantidade" pro Relatório Separado ──
    const values = rows.map(r => r.value);
    const stats = {
      totalValue,
      avgValue: totalDeliveries ? totalValue / totalDeliveries : 0,
      maxValue: values.length ? Math.max(...values) : 0,
      minValue: values.length ? Math.min(...values) : 0,
      totalDeliveries,
      deliveriesByCourier: byCourier.map(c => ({ courier: c.courier, deliveries: c.deliveries, total: c.total })),
      deliveriesByHood: combinedByHood.map(h => ({ hood: h.hood, deliveries: h.deliveries, total: h.total }))
    };

    return sendJSON(res, 200, {
      payMode: pay.mode,
      totalDeliveries,
      totalValue,
      byCourier,
      combinedByHood,
      rows,
      stats
    });
  }

  // v109: GET /api/me — devolve role/permissões/status ATUALIZADOS pro token atual. O painel
  // chama isso ao abrir/voltar de segundo plano pra saber na hora se o Master mudou alguma
  // permissão (ou desativou o usuário) enquanto a aba ficava aberta — sem precisar deslogar.
  if (pathname === '/api/me' && req.method === 'GET') {
    const session = getSession(getToken(req, query));
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });
    const user = findUserBySession(session);
    if (user && user.active === false) return sendJSON(res, 403, { error: 'Usuário desativado.', deactivated: true });
    return sendJSON(res, 200, { role: session.role, username: session.username, permissions: effectivePermissions(session) });
  }

  // ── POST /api/login — autenticação do painel (usuário + senha, com nível de acesso) ──
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const { username, password } = await readBody(req);
      const { cfg } = readConfig();
      const uname = String(username || '').trim().toLowerCase();

      if (uname) {
        const user = (cfg.users || []).find(u => String(u.username || '').toLowerCase() === uname);
        if (user && user.active === false) return sendJSON(res, 403, { error: 'Este usuário está desativado. Fale com o administrador master.' });
        if (user && verifyUserPassword(user, password)) {
          // Migração silenciosa: conta antiga só com senha em texto puro vira hash agora que
          // provou saber a senha certa — nenhuma ação extra pedida ao usuário.
          if (!user.passwordHash) {
            const data = readConfig();
            const u2 = (data.cfg.users || []).find(u => String(u.username || '').toLowerCase() === uname);
            if (u2) { u2.passwordHash = hashUserPassword(u2.username, password); delete u2.password; writeJSON(CONFIG_FILE, data); }
          }
          return sendJSON(res, 200, { token: newSession(user.role, user.username), role: user.role, username: user.username, permissions: effectivePermissions({ role: user.role, username: user.username }) });
        }
        return sendJSON(res, 401, { error: 'Usuário ou senha incorretos.' });
      }

      // Compatibilidade: login sem usuário (só senha) continua funcionando como antes.
      if (password === cfg.adminPass) return sendJSON(res, 200, { token: newSession('admin', 'admin'), role: 'admin', username: 'admin', permissions: effectivePermissions({ role: 'admin', username: 'admin' }) });
      if (password === cfg.masterPass) return sendJSON(res, 200, { token: newSession('master', 'master'), role: 'master', username: 'master', permissions: fullPermTemplate(true) });
      return sendJSON(res, 401, { error: 'senha incorreta' });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/pix — gera o copia-e-cola para um valor ──
  // ── POST /api/orders/:id/mark-paid — restaurante confirma manualmente que o PIX caiu (painel, requer auth) ──
  // Essa é a forma mais simples e recomendada: funciona sempre, sem depender de nenhuma conta de gateway.
  if (pathname.match(/^\/api\/orders\/[^/]+\/mark-paid$/) && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = pathname.split('/')[3];
    const orders = readJSON(ORDERS_FILE);
    const order = orders.find(o => o.id === id);
    if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
    order.paid = true; order.paidAt = new Date().toISOString(); order.paidVia = 'manual';
    writeJSON(ORDERS_FILE, orders);
    broadcast('order-updated', order);
    return sendJSON(res, 200, { ok: true, order });
  }

  // ── POST /api/webhook/pix — confirmação automática (OPCIONAL, exige conta própria no Mercado Pago) ──
  // Como configurar: 1) gere um Access Token de PRODUÇÃO na sua conta Mercado Pago e cole em
  // Configurações → PIX → "Confirmação automática"; 2) na sua conta Mercado Pago, cadastre esta URL
  // completa (ex: https://seusite.com/api/webhook/pix) como webhook de pagamentos; 3) ao criar a
  // cobrança PIX pelo painel/checkout do Mercado Pago, use o ID do pedido (mostrado no painel, ex:
  // SGMRXXPU8H) como "external_reference" da cobrança — é assim que este servidor sabe qual pedido
  // marcar como pago quando a notificação chegar.
  // Segurança: o corpo do webhook NUNCA é confiado diretamente (qualquer um poderia forjar uma
  // requisição pra essa URL) — sempre confirmamos consultando a própria API do Mercado Pago com o
  // Access Token, e só marcamos como pago se o status vier "approved" de lá.
  if (pathname === '/api/webhook/pix' && req.method === 'POST') {
    try {
      const { cfg } = readConfig();
      const gw = cfg.pixGateway || {};
      if (!gw.enabled || !gw.accessToken) return sendJSON(res, 200, { ok: true }); // ignora silenciosamente se não configurado
      const body = await readBody(req);
      const paymentId = body?.data?.id || body?.id;
      if (!paymentId) return sendJSON(res, 200, { ok: true });
      const payment = await httpsGetJSON(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        Authorization: `Bearer ${gw.accessToken}`
      });
      if (payment && payment.status === 'approved' && payment.external_reference) {
        const orders = readJSON(ORDERS_FILE);
        const order = orders.find(o => o.id === payment.external_reference);
        if (order && !order.paid) {
          order.paid = true; order.paidAt = new Date().toISOString(); order.paidVia = 'gateway';
          writeJSON(ORDERS_FILE, orders);
          broadcast('order-updated', order);
        }
      }
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 200, { ok: true }); } // webhook sempre responde 200 (padrão do provedor), erro só fica no log
  }

  if (pathname === '/api/pix' && req.method === 'POST') {
    try {
      const { amount, txid } = await readBody(req);
      const { cfg } = readConfig();
      if (!cfg.pixKey) return sendJSON(res, 400, { error: 'PIX não configurado pelo restaurante' });
      const payload = buildPixPayload({
        pixKey: cfg.pixKey, merchantName: cfg.pixName, merchantCity: cfg.pixCity, amount, txid
      });
      const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(payload)}`;
      return sendJSON(res, 200, { payload, qrImg });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/delivery-fee — cliente informa CEP/endereço, taxa é calculada conforme o modo configurado ──
  // ── GET /api/cep/:cep — busca endereço pelo CEP (autopreenchimento no checkout) ──
  if (pathname.match(/^\/api\/cep\/[^/]+$/) && req.method === 'GET') {
    const cep = pathname.split('/').pop();
    try {
      const addr = await lookupCEP(cep);
      if (!addr) return sendJSON(res, 200, { ok: false, error: 'CEP não encontrado.' });
      return sendJSON(res, 200, { ok: true, ...addr });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: 'Não foi possível buscar esse CEP agora.' }); }
  }

  // ── POST /api/reverse-geocode — usado pelo botão "usar minha localização" no checkout ──
  if (pathname === '/api/reverse-geocode' && req.method === 'POST') {
    try {
      const { lat, lng } = await readBody(req);
      if (typeof lat !== 'number' || typeof lng !== 'number') return sendJSON(res, 400, { error: 'Coordenadas inválidas.' });
      const addr = await reverseGeocode(lat, lng);
      if (!addr) return sendJSON(res, 200, { ok: false, error: 'Não conseguimos identificar seu endereço. Preencha manualmente.' });
      return sendJSON(res, 200, { ok: true, ...addr });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: 'Não conseguimos identificar seu endereço. Preencha manualmente.' }); }
  }

  if (pathname === '/api/delivery-fee' && req.method === 'POST') {
    try {
      const { cep, street, hood, city, uf } = await readBody(req);
      const { cfg } = readConfig();
      const cleanCep = String(cep || '').replace(/\D/g, '');

      // ── Modo CEP: cada faixa de CEP tem uma taxa fixa configurada ──
      if (cfg.feeMode === 'cep') {
        if (!cleanCep) return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
        const match = matchCepZone(cleanCep, cfg.feeZonesCep);
        if (match) return sendJSON(res, 200, { fee: Number(match.fee) || 0, mode: 'cep', zoneLabel: match.label || match.prefix, distanceKm: null });
        if (cfg.feeZoneFallback === 'bloqueado') {
          return sendJSON(res, 200, { error: 'fora_area', message: `Esse CEP ainda não está na nossa área de entrega.` });
        }
        return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
      }

      // ── Modo Bairro: cada bairro cadastrado tem uma taxa fixa configurada ──
      if (cfg.feeMode === 'bairro') {
        let addrHood = String(hood || '').trim();
        if (!addrHood && cleanCep) {
          try { const viacep = await lookupCEP(cleanCep); if (viacep) addrHood = viacep.hood; } catch (e) {}
        }
        if (!addrHood) return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
        const match = matchBairroZone(addrHood, cfg.feeZonesBairro);
        if (match) return sendJSON(res, 200, { fee: Number(match.fee) || 0, mode: 'bairro', zoneLabel: match.bairro, distanceKm: null });
        if (cfg.feeZoneFallback === 'bloqueado') {
          return sendJSON(res, 200, { error: 'fora_area', message: `Ainda não entregamos no bairro "${addrHood}".` });
        }
        return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
      }

      // Se o restaurante não usa taxa por distância (ou ainda não configurou as
      // coordenadas da loja), devolve a taxa padrão direto — sem chamar nada externo.
      if (cfg.feeMode !== 'distancia' || !cfg.storeLat || !cfg.storeLng) {
        return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo', distanceKm: null });
      }

      try {
        let addrStreet = String(street || '').trim();
        let addrHood = String(hood || '').trim();
        let addrCity = String(city || '').trim();
        let addrUf = String(uf || '').trim();

        // Se veio CEP, usa ele para completar/confirmar bairro-cidade-UF (mais preciso)
        if (cleanCep) {
          const viacep = await lookupCEP(cleanCep);
          if (viacep) {
            addrHood = addrHood || viacep.hood;
            addrCity = addrCity || viacep.city;
            addrUf = addrUf || viacep.uf;
            if (!addrStreet) addrStreet = viacep.street;
          }
        }

        const queryText = [addrStreet, addrHood, addrCity, addrUf, 'Brasil'].filter(Boolean).join(', ');
        if (!queryText || (!addrStreet && !addrHood && !cleanCep)) {
          return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
        }

        const geo = await geocodeAddress(queryText);
        if (!geo) {
          return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
        }

        const distanceKm = haversineKm(Number(cfg.storeLat), Number(cfg.storeLng), geo.lat, geo.lng);
        const maxKm = Number(cfg.feeMaxKm) || 0;
        if (maxKm > 0 && distanceKm > maxKm) {
          return sendJSON(res, 200, { error: 'fora_area', distanceKm: Math.round(distanceKm * 10) / 10, maxKm });
        }

        const fee = calcFeeByDistance(cfg, distanceKm);
        return sendJSON(res, 200, { fee, mode: 'distancia', distanceKm: Math.round(distanceKm * 10) / 10 });
      } catch (geoErr) {
        // Qualquer falha nas APIs externas (fora do ar, CEP não encontrado, etc.)
        // não pode travar o pedido — cai para a taxa padrão configurada.
        return sendJSON(res, 200, { fee: Number(cfg.fee) || 0, mode: 'fixo_fallback', distanceKm: null });
      }
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/admin/detect-usb-printers — procura impressoras USB conectadas ──
  // IMPORTANTE: só encontra algo se o server.js estiver rodando na MESMA máquina
  // física ligada na impressora (ex: um PC/Raspberry Pi no balcão). Rodando no
  // Render (nuvem), nunca vai achar nada — a impressora não está fisicamente
  // conectada ao servidor na nuvem.
  if (pathname === '/api/admin/detect-usb-printers' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarImpressoras')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão.' });
    const candidates = [];
    try {
      ['/dev/usb', '/dev'].forEach(dir => {
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(f => {
            if (/^(lp\d+|ttyUSB\d+)$/.test(f)) candidates.push(path.join(dir, f));
          });
        }
      });
    } catch (e) {}
    return sendJSON(res, 200, {
      found: candidates,
      note: candidates.length
        ? null
        : 'Nenhuma impressora USB encontrada. Se o servidor estiver rodando na nuvem (Render), isso é esperado — a busca só funciona quando o servidor roda no mesmo computador físico ligado na impressora.'
    });
  }

  // ── GET /api/admin/detect-network-printers — varre a rede LOCAL DO SERVIDOR por impressoras ──
  // MESMA RESSALVA: procura na rede de quem está rodando o server.js. No Render,
  // isso é a rede interna da nuvem — nunca vai enxergar o Wi-Fi do restaurante.
  // Só é útil de verdade se o servidor rodar localmente, na mesma rede da impressora.
  if (pathname === '/api/admin/detect-network-printers' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'configurarImpressoras')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão.' });
    const nets = os.networkInterfaces();
    let base = null;
    Object.values(nets).flat().forEach(n => {
      if (n && n.family === 'IPv4' && !n.internal && n.address.startsWith('192.168.')) {
        base = n.address.split('.').slice(0, 3).join('.');
      }
    });
    if (!base) {
      return sendJSON(res, 200, { found: [], note: 'Não foi possível identificar uma rede local Wi-Fi a partir deste servidor — normal se ele estiver rodando na nuvem (Render).' });
    }
    const tryPort = (ip) => new Promise((resolve) => {
      const socket = net.createConnection({ host: ip, port: 9100, timeout: 400 }, () => { socket.destroy(); resolve(ip); });
      socket.on('error', () => resolve(null));
      socket.on('timeout', () => { socket.destroy(); resolve(null); });
    });
    const results = await Promise.all(Array.from({ length: 254 }, (_, i) => tryPort(`${base}.${i + 1}`)));
    const found = results.filter(Boolean);
    return sendJSON(res, 200, { found, note: found.length ? null : `Nenhuma impressora respondendo na porta 9100 dentro de ${base}.0/24.` });
  }


  // ── POST /api/admin/geocode-by-cep — localiza a loja a partir do CEP, usando a BrasilAPI
  // (serviço brasileiro, com infraestrutura própria — não sofre do bloqueio de IP compartilhado
  // que o Nominatim às vezes aplica em servidores como o Render). Quando a BrasilAPI já tem a
  // coordenada cadastrada pro CEP, usa direto; senão, monta o endereço a partir do CEP e cai no
  // mesmo fluxo de geocodificação por texto (Nominatim → Photon) como último recurso. ──
  if (pathname === '/api/admin/geocode-by-cep' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const cep = String(body.cep || '').replace(/\D/g, '');
      if (cep.length !== 8) return sendJSON(res, 400, { error: 'Digite um CEP válido, com 8 dígitos (ex: 28890-000).' });

      let cepData = null;
      try {
        cepData = await httpsGetJSON(`https://brasilapi.com.br/api/cep/v2/${cep}`, {}, 8000);
      } catch (e) {
        console.error('⚠️  BrasilAPI não respondeu pro CEP', cep, ':', e.message);
      }
      if (!cepData) return sendJSON(res, 404, { error: 'CEP não encontrado. Confira se digitou certo, ou use o campo de coordenadas manuais abaixo.' });

      // A BrasilAPI às vezes já vem com a coordenada pronta pra esse CEP — o caminho mais rápido e confiável
      const coords = cepData.location && cepData.location.coordinates;
      if (coords && coords.latitude && coords.longitude) {
        const cepFull = readConfig();
        cepFull.cfg.storeLat = parseFloat(coords.latitude);
        cepFull.cfg.storeLng = parseFloat(coords.longitude);
        writeJSON(CONFIG_FILE, cepFull);
        const cfg = cepFull.cfg;
        return sendJSON(res, 200, {
          lat: cfg.storeLat, lng: cfg.storeLng,
          label: [cepData.street, cepData.neighborhood, cepData.city, cepData.state].filter(Boolean).join(', '),
          source: 'brasilapi-direto'
        });
      }

      // Sem coordenada pronta: monta o endereço a partir do que o CEP devolveu e tenta geocodificar o texto
      const addressFromCep = [cepData.street, cepData.neighborhood, cepData.city, cepData.state, 'Brasil'].filter(Boolean).join(', ');
      const geo = await geocodeAddress(addressFromCep);
      if (!geo) return sendJSON(res, 404, { error: `Achamos o endereço do CEP (${addressFromCep}), mas não conseguimos converter em coordenadas agora. Use o campo de coordenadas manuais abaixo.` });
      const geoFull = readConfig();
      geoFull.cfg.storeLat = geo.lat; geoFull.cfg.storeLng = geo.lng;
      writeJSON(CONFIG_FILE, geoFull);
      return sendJSON(res, 200, { lat: geo.lat, lng: geo.lng, label: geo.label || addressFromCep, source: 'geocoded' });
    } catch (e) {
      console.error('❌ Falha ao geocodificar por CEP:', e.message);
      return sendJSON(res, 500, { error: 'Não conseguimos processar esse CEP agora. Use o campo de coordenadas manuais abaixo.' });
    }
  }

  if (pathname === '/api/admin/geocode-store' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const data = readConfig();
      const address = String(body.address || data.cfg.addr || '').trim();
      if (!address) return sendJSON(res, 400, { error: 'Informe o endereço do restaurante.' });
      const geo = await geocodeAddress(address + ', Brasil');
      if (!geo) return sendJSON(res, 404, { error: 'Não conseguimos localizar esse endereço. Tente descrevê-lo de outro jeito (ex: rua, número, bairro, cidade).' });
      data.cfg.storeLat = geo.lat;
      data.cfg.storeLng = geo.lng;
      writeJSON(CONFIG_FILE, data);
      return sendJSON(res, 200, { lat: geo.lat, lng: geo.lng, label: geo.label });
    } catch (e) {
      console.error('❌ Falha ao geocodificar endereço da loja:', e.message);
      const isBlocked = /HTTP 429/.test(e.message);
      return sendJSON(res, 500, {
        error: isBlocked
          ? 'O serviço gratuito de mapas está limitando as requisições vindas deste servidor no momento (isso é comum em hospedagens compartilhadas como o Render, e pode continuar acontecendo). Em vez de ficar tentando de novo, digite as coordenadas manualmente no campo ao lado — pegue elas no Google Maps: clique com o botão direito no local exato da loja e copie os dois números que aparecem.'
          : 'Não conseguimos falar com o serviço de mapas agora (' + e.message + '). Digite as coordenadas manualmente no campo ao lado, ou tente de novo em alguns instantes.'
      });
    }
  }

  // ── GET /api/admin/backup — exporta os dados em vários formatos de arquivo ──
  // ?format=json  -> backup completo (config + pedidos + clientes), pra restaurar depois
  // ?format=csv&type=clientes|pedidos -> planilha simples (abre no Excel/Sheets)
  // ?format=txt&type=cardapio -> cardápio em texto simples, fácil de ler/imprimir
  if (pathname === '/api/admin/backup' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'sistema', 'logs')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra exportar dados.' });
    const format = query.format || 'json';
    const type = query.type || '';
    const stamp = new Date().toISOString().slice(0, 10);

    const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const sendFile = (filename, contentType, body) => {
      res.writeHead(200, {
        'Content-Type': contentType + '; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(body);
    };

    if (format === 'csv' && type === 'clientes') {
      const customers = readJSON(CUSTOMERS_FILE);
      const rows = [['Nome', 'Telefone', 'Cadastrado em', 'Último Endereço'].join(',')]
        .concat(customers.map(c => [csvEscape(c.name), csvEscape(c.phone), csvEscape(c.createdAt), csvEscape(c.lastAddress || '')].join(',')));
      return sendFile(`clientes-${stamp}.csv`, 'text/csv', '\uFEFF' + rows.join('\r\n'));
    }

    if (format === 'csv' && type === 'pedidos') {
      const orders = readJSON(ORDERS_FILE);
      const rows = [['Pedido', 'Data', 'Status', 'Cliente', 'Modo', 'Itens', 'Subtotal', 'Taxa', 'Desconto', 'Total', 'Pagamento'].join(',')]
        .concat(orders.map(o => [
          csvEscape(o.id), csvEscape(o.createdAt), csvEscape(o.status), csvEscape(o.name), csvEscape(o.mode),
          csvEscape((o.items || []).map(i => `${i.qty}x ${i.name}`).join(' | ')),
          csvEscape(o.subtotal), csvEscape(o.fee), csvEscape(o.discount || 0), csvEscape(o.total), csvEscape(o.payMethod)
        ].join(',')));
      return sendFile(`pedidos-${stamp}.csv`, 'text/csv', '\uFEFF' + rows.join('\r\n'));
    }

    if (format === 'txt' && type === 'cardapio') {
      const { menu } = readConfig();
      const lines = ['CARDÁPIO — exportado em ' + new Date().toLocaleString('pt-BR'), ''];
      menu.forEach(sec => {
        lines.push('═'.repeat(40));
        lines.push((sec.icon || '') + ' ' + sec.title.toUpperCase());
        lines.push('═'.repeat(40));
        sec.items.forEach(it => {
          lines.push(`- ${it.name} ......... R$ ${Number(it.price).toFixed(2)}`);
          if (it.desc) lines.push(`  ${it.desc}`);
          if (it.available === false) lines.push('  [ESGOTADO]');
        });
        lines.push('');
      });
      return sendFile(`cardapio-${stamp}.txt`, 'text/plain', lines.join('\n'));
    }

    // formato padrão: backup completo em JSON, pra restaurar depois se precisar
    const data = readConfig();
    const orders = readJSON(ORDERS_FILE);
    const customers = readJSON(CUSTOMERS_FILE);
    const backup = { exportedAt: new Date().toISOString(), version: 1, cfg: data.cfg, menu: data.menu, orders, customers };
    return sendFile(`shogatsu-backup-${stamp}.json`, 'application/json', JSON.stringify(backup, null, 2));
  }

  // ── POST /api/admin/restore — restaura um backup completo exportado antes ──
  // Sobrescreve config, cardápio, pedidos e clientes atuais — usar com cuidado.
  if (pathname === '/api/admin/restore' && req.method === 'POST') {
    if (!requireRole(getToken(req, query), 'master')) return sendJSON(res, 403, { error: 'Só o usuário master pode restaurar um backup.' });
    try {
      const body = await readBody(req);
      if (!body || body.version !== 1 || !body.cfg || !body.menu) {
        return sendJSON(res, 400, { error: 'Arquivo de backup inválido ou de uma versão não reconhecida.' });
      }
      const current = readConfig();
      writeJSON(CONFIG_FILE, {
        cfg: { ...current.cfg, ...body.cfg, adminPass: current.cfg.adminPass, masterPass: current.cfg.masterPass },
        menu: body.menu
      });
      if (Array.isArray(body.orders)) writeJSON(ORDERS_FILE, body.orders);
      if (Array.isArray(body.customers)) writeJSON(CUSTOMERS_FILE, body.customers);
      publicBroadcast('menu-updated', {});
      return sendJSON(res, 200, {
        ok: true,
        restored: { pedidos: (body.orders || []).length, clientes: (body.customers || []).length, categorias: (body.menu || []).length }
      });
    } catch (e) { return sendJSON(res, 400, { error: 'Não foi possível ler esse arquivo de backup.' }); }
  }


// pedido + o texto configurado em cfg.time (ex: "40–60 min"). Se não conseguir
// extrair dois números do texto, devolve só o texto original como está.
// Calcula uma janela de horário estimada de entrega/retirada a partir da hora do
// pedido + o texto configurado em cfg.time (ex: "40–60 min"). Se não conseguir
// extrair dois números do texto, devolve só o texto original como está.
function estimateDeliveryWindow(order, cfg) {
  // v34: BUG CORRIGIDO — retirada usava a mesma estimativa de tempo do delivery, mesmo sendo
  // bem mais rápida na prática. Agora cada modo tem seu próprio texto configurável.
  const timeText = order.mode === 'retirada' ? (cfg.timeRetirada || cfg.time) : cfg.time;
  const nums = String(timeText || '').match(/\d+/g);
  const created = new Date(order.createdAt);
  // v133 — BUG CORRIGIDO ("previsão de entrega errada na comanda", ex.: pedido feito às
  // 00:18 mostrando previsão 03:58–04:18 em vez de 00:58–01:18): o servidor roda hospedado
  // num relógio configurado em UTC (padrão de praticamente todo host na nuvem), e essa função
  // formatava o horário sem dizer EM QUE FUSO — o Node então usa o fuso do SISTEMA (UTC), não
  // o horário de Brasília (UTC-3), o que empurra a previsão pra 3 horas à frente do horário
  // real. `timeZone: 'America/Sao_Paulo'` já era usado em outro lugar do sistema (linha ~658)
  // exatamente por essa razão — só faltava aplicar aqui também.
  const fmt = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  if (nums && nums.length >= 2) {
    const from = new Date(created.getTime() + parseInt(nums[0]) * 60000);
    const to = new Date(created.getTime() + parseInt(nums[nums.length - 1]) * 60000);
    return `${fmt(from)} – ${fmt(to)}`;
  }
  if (nums && nums.length === 1) {
    const to = new Date(created.getTime() + parseInt(nums[0]) * 60000);
    return `até ${fmt(to)}`;
  }
  return timeText || '—';
}

  // ── POST /api/print-ack — o Agente Local avisa se uma via imprimiu ou falhou (v60) ──
  // Fecha o ciclo do "celular como controle remoto": o clique em Imprimir pode ter partido de
  // qualquer aparelho logado; aqui a gente repassa o resultado de volta pra TODOS os painéis
  // conectados (broadcast), e cada um decide se estava esperando essa confirmação específica
  // (ver pendingPrintAcks/evento 'print-result' em painel.html). Falhas também ficam guardadas
  // em disco (print-log.json) pra dar pra conferir depois, mesmo sem estar com o painel aberto
  // no momento em que a impressora falhou.
  if (pathname === '/api/print-ack' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { orderId, station, ok, error } = await readBody(req);
      if (!orderId || !station) return sendJSON(res, 400, { error: 'orderId e station são obrigatórios.' });
      // v122: fecha o ciclo da trava automática. Sucesso vira DONE; falha libera a via para retry.
      try {
        const orders = readJSON(ORDERS_FILE); const oi = orders.findIndex(o=>o.id===orderId);
        if(oi>-1){ const o=orders[oi]; if(!o.autoPrintState)o.autoPrintState={};
          if(ok){ o.autoPrintState[station]={status:'done',finishedAt:new Date().toISOString()}; o.autoPrinted=o.autoPrinted||{}; o.autoPrinted[station]=true; }
          else { delete o.autoPrintState[station]; if(o.autoPrinted) delete o.autoPrinted[station]; }
          orders[oi]=o; writeJSON(ORDERS_FILE,orders);
        }
      } catch(e) { console.error('⚠️ Não consegui atualizar estado da impressão:',e.message); }
      if (!ok) {
        try {
          const log = readJSON(PRINT_LOG_FILE);
          log.unshift({ orderId, station, error: String(error || 'Falha desconhecida').slice(0, 500), ts: new Date().toISOString(), retryable:true });
          fs.writeFileSync(PRINT_LOG_FILE, JSON.stringify(log.slice(0, 500), null, 2));
        } catch (e) { console.error('⚠️  Não consegui gravar print-log.json:', e.message); }
      }
      broadcast('print-result', { orderId, station, ok: !!ok, error: error || null });
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── GET /api/print-log — últimas falhas de impressão registradas (v60) ──
  if (pathname === '/api/print-log' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try { return sendJSON(res, 200, { log: readJSON(PRINT_LOG_FILE) }); }
    catch (e) { return sendJSON(res, 200, { log: [] }); }
  }

  // ── POST /api/print-agent/claim — v106: RECLAMA (reserva) o direito de imprimir UMA via
  // automática de UM pedido/reserva específico, de forma idempotente e persistida em disco.
  // Substitui, pro caminho de impressão AUTOMÁTICA do Agente Local (método "automatica" —
  // evento 'new-order'/'new-reservation-print' via SSE), a antiga trava de "Estação Ativa"
  // (v90, baseada em qual PAINEL/navegador estava aberto por último) — que tinha um problema
  // real: bloqueava QUALQUER outro computador/celular de imprimir (mesmo estações diferentes,
  // ex.: COZINHA sendo bloqueada só porque o painel do CAIXA foi aberto por último em outro
  // PC), o oposto do que o v106 pede (várias estações/dispositivos simultâneos, cada um com
  // sua própria impressora). A proteção de verdade contra duplicidade não precisa saber QUAL
  // painel está aberto — só precisa garantir que aquele PEDIDO+VIA específico (ou aquela
  // RESERVA) só seja "reclamado" (impresso automaticamente) UMA vez, não importa quantos
  // Agentes/painéis estejam online ao mesmo tempo. Reaproveita o campo `order.autoPrinted`
  // que já existia (v86, usado pelo caminho "navegador") — sem criar arquivo/estrutura nova.
  // Idempotente: F5, reconexão do WebSocket/SSE, retry, reinício do Agent ou do servidor nunca
  // duplicam, porque o estado fica gravado no próprio pedido/reserva em disco (ORDERS_FILE/
  // RESERVATIONS_FILE), não em memória.
  if (pathname === '/api/print-agent/claim' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { kind, id, station } = await readBody(req);
      const now=Date.now(), leaseMs=90000;
      if (kind === 'reservation') {
        const list=readJSON(RESERVATIONS_FILE); const idx=list.findIndex(r=>r.id===id); if(idx===-1)return sendJSON(res,404,{error:'Reserva não encontrada.',claimed:false});
        const r=list[idx]; const state=r.autoPrintState; if(r.autoPrinted||state?.status==='done')return sendJSON(res,200,{claimed:false,alreadyClaimed:true});
        if(state?.status==='printing' && now-Number(state.claimedAt||0)<leaseMs)return sendJSON(res,200,{claimed:false,alreadyPrinting:true});
        r.autoPrintState={status:'printing',claimedAt:now}; list[idx]=r; writeJSON(RESERVATIONS_FILE,list); return sendJSON(res,200,{claimed:true});
      }
      if(!station)return sendJSON(res,400,{error:'station obrigatório.',claimed:false});
      const orders=readJSON(ORDERS_FILE); const idx=orders.findIndex(o=>o.id===id); if(idx===-1)return sendJSON(res,404,{error:'Pedido não encontrado.',claimed:false});
      const o=orders[idx]; o.autoPrintState=o.autoPrintState||{}; const state=o.autoPrintState[station];
      if(o.autoPrinted?.[station] || state?.status==='done')return sendJSON(res,200,{claimed:false,alreadyClaimed:true});
      if(state?.status==='printing' && now-Number(state.claimedAt||0)<leaseMs)return sendJSON(res,200,{claimed:false,alreadyPrinting:true});
      o.autoPrintState[station]={status:'printing',claimedAt:now}; orders[idx]=o; writeJSON(ORDERS_FILE,orders); return sendJSON(res,200,{claimed:true});
    } catch(e){return sendJSON(res,400,{error:'invalid body',claimed:false});}
  }

  // v122 — libera/fecha reservas de impressão quando o agente termina ou falha.
  if (pathname === '/api/print-agent/release' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res,401,{error:'unauthorized'});
    try{ const {kind,id,station}=await readBody(req); if(kind==='reservation'){const list=readJSON(RESERVATIONS_FILE);const i=list.findIndex(r=>r.id===id);if(i>-1){delete list[i].autoPrintState;writeJSON(RESERVATIONS_FILE,list);}} else {const orders=readJSON(ORDERS_FILE);const i=orders.findIndex(o=>o.id===id);if(i>-1){delete (orders[i].autoPrintState||{})[station];if(orders[i].autoPrinted)delete orders[i].autoPrinted[station];writeJSON(ORDERS_FILE,orders);}} return sendJSON(res,200,{ok:true}); }catch(e){return sendJSON(res,400,{error:'invalid body'});}
  }
  if (pathname === '/api/print-agent/complete' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res,401,{error:'unauthorized'});
    try{ const {kind,id,station}=await readBody(req); if(kind==='reservation'){const list=readJSON(RESERVATIONS_FILE);const i=list.findIndex(r=>r.id===id);if(i>-1){list[i].autoPrinted=true;delete list[i].autoPrintState;writeJSON(RESERVATIONS_FILE,list);}} else {const orders=readJSON(ORDERS_FILE);const i=orders.findIndex(o=>o.id===id);if(i>-1){orders[i].autoPrinted=orders[i].autoPrinted||{};orders[i].autoPrinted[station]=true;orders[i].autoPrintState=orders[i].autoPrintState||{};orders[i].autoPrintState[station]={status:'done',finishedAt:new Date().toISOString()};writeJSON(ORDERS_FILE,orders);}} return sendJSON(res,200,{ok:true}); }catch(e){return sendJSON(res,400,{error:'invalid body'});}
  }

  // ── POST /api/print-agent/announce — o Agente Local avisa "estou vivo" (v82) ──
  // Chamado pelo print-agent.js logo após conectar e depois a cada ~45s. Não precisa de nenhum
  // dado sensível: só label/vias de cada impressora configurada nele, pra o painel poder
  // mostrar "✅ Agente conectado (Caixa USB → caixa; Sushibar Rede → sushibar,bar)".
  if (pathname === '/api/print-agent/announce' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { agentId, printers, build } = await readBody(req);
      if (!agentId) return sendJSON(res, 400, { error: 'agentId obrigatório.' });
      printAgents.set(String(agentId), {
        printers: Array.isArray(printers) ? printers.slice(0, 20).map(p => ({
          label: String(p.label || 'Impressora').slice(0, 60),
          stations: Array.isArray(p.stations) ? p.stations.slice(0, 20) : []
        })) : [],
        build: build ? String(build).slice(0, 20) : null, // v95: qual build do print-agent.js está rodando de fato
        lastSeen: Date.now()
      });
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/print-terminal/announce — um painel marcado como "🖥️ Terminal de Impressão"
  // avisa "estou vivo" (v85), no mesmo espírito do /api/print-agent/announce acima. Chamado
  // pelo painel.html a cada ~45s enquanto a caixinha estiver marcada e a página aberta.
  if (pathname === '/api/print-terminal/announce' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { terminalId } = await readBody(req);
      if (!terminalId) return sendJSON(res, 400, { error: 'terminalId obrigatório.' });
      printTerminals.set(String(terminalId), { lastSeen: Date.now() });
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/health — diagnóstico leve para monitoramento/deploy. Não expõe dados do restaurante.
  if (pathname === '/api/health' && req.method === 'GET') {
    const checks = {};
    for (const [name, file] of Object.entries({config: CONFIG_FILE, orders: ORDERS_FILE, customers: CUSTOMERS_FILE})) {
      try { fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK); checks[name] = true; } catch (_) { checks[name] = false; }
    }
    const ok = Object.values(checks).every(Boolean);
    return sendJSON(res, ok ? 200 : 503, {ok, service:'shogatsu-pedidos', version:'1.0.133', checks, uptimeSec:Math.floor(process.uptime()), time:new Date().toISOString()});
  }

  // ── GET /api/print-agent/status — o painel consulta pra mostrar se tem algum Agente Local
  // conectado agora, e quais vias cada um cobre (v82); agora também informa quantos
  // Terminais de Impressão (modo Navegador) estão de fato ativos agora (v85) ──
  if (pathname === '/api/print-agent/status' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const agents = getOnlinePrintAgents();
    const coveredStations = [...new Set(agents.flatMap(a => a.printers.flatMap(p => p.stations)))];
    return sendJSON(res, 200, { online: agents.length > 0, agents, coveredStations, terminalsOnline: getOnlinePrintTerminalsCount(), currentAgentBuild: CURRENT_AGENT_BUILD });
  }

  // ── GET /api/print-agent/pending — v125-part1: recuperação de impressão após queda de SSE/rede.
  // O Agente Local consulta esta fila periodicamente. Assim, se ele estava offline quando o
  // evento 'new-order' aconteceu, o pedido não fica perdido: ele reaparece aqui até cada via
  // ser concluída. A trava por pedido+via continua sendo feita em /api/print-agent/claim, então
  // dois agentes consultando a mesma fila não imprimem a mesma via duas vezes.
  if (pathname === '/api/print-agent/pending' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const now = Date.now();
      const maxAgeMs = 48 * 60 * 60 * 1000;
      // v131 — corrige "tempo de entrega deve ser o que está definido no sistema": os pedidos
      // recuperados por aqui (Agente Local que estava offline quando o pedido chegou) não
      // levavam o horário de previsão calculado (_deliveryWindow) — só o broadcast 'new-order'
      // levava isso. Agora os dois caminhos calculam do mesmo jeito, com a MESMA configuração
      // (cfg.time/cfg.timeRetirada), então o Agente Local mostra o horário certo não importa
      // se recebeu o pedido em tempo real ou recuperou depois de reconectar.
      const { cfg } = readConfig();
      const orders = readJSON(ORDERS_FILE)
        .filter(o => o && o.autoPrintEligible === true && !['cancelado','entregue'].includes(o.status))
        .filter(o => now - new Date(o.createdAt || 0).getTime() <= maxAgeMs)
        .filter(o => {
          const states = o.autoPrintState || {};
          return !o.autoPrinted || Object.keys(states).some(st => states[st]?.status !== 'done') || Object.keys(states).length === 0;
        })
        .slice(0, 100)
        .map(o => ({ ...o, _deliveryWindow: estimateDeliveryWindow(o, cfg) }));
      const reservations = readJSON(RESERVATIONS_FILE)
        .filter(r => r && r.autoPrintEligible === true)
        .filter(r => now - new Date(r.createdAt || 0).getTime() <= maxAgeMs)
        .filter(r => !r.autoPrinted && r.autoPrintState?.status !== 'done')
        .slice(0, 100);
      return sendJSON(res, 200, { ok: true, orders, reservations, serverTime: new Date().toISOString() });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Não foi possível consultar a fila de impressão.', retryable: true });
    }
  }

  // ── POST /api/print-station/register — o Painel avisa que abriu/está ativo AGORA e assume
  // a Estação Ativa de Impressão imediatamente (v90). Chamado uma vez ao abrir o Painel (login
  // ou recarregar com sessão já válida) — o mais recente a abrir sempre assume, a estação
  // anterior perde autorização na hora (regra pedida: "outro computador que abrir o painel
  // assume automaticamente").
  if (pathname === '/api/print-station/register' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { stationId, label } = await readBody(req);
      if (!stationId || !String(stationId).trim()) return sendJSON(res, 400, { error: 'stationId obrigatório.' });
      claimActiveStation(stationId, label);
      return sendJSON(res, 200, { ok: true, activeStationId: activeStation.stationId, activeLabel: activeStation.label });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/print-station/heartbeat — sinal de vida periódico da estação (v90), chamado
  // pelo painel.html a cada ~15s enquanto a página estiver aberta e logada. Se a estação ativa
  // atual ficou sem heartbeat por mais de ACTIVE_STATION_TIMEOUT_MS (painel fechado, aba
  // trocada, computador desligado), ESTE stationId assume sozinho no próximo heartbeat dele
  // (failover automático); senão só confirma presença.
  if (pathname === '/api/print-station/heartbeat' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { stationId, label } = await readBody(req);
      if (!stationId || !String(stationId).trim()) return sendJSON(res, 400, { error: 'stationId obrigatório.' });
      const sid = String(stationId).trim();
      if (activeStation && activeStation.stationId === sid) {
        activeStation.lastSeen = Date.now();
        knownStations.set(sid, { label: activeStation.label, lastSeen: activeStation.lastSeen });
      } else if (!isActiveStationAlive()) {
        claimActiveStation(sid, label); // estação ativa anterior caiu (ou nunca existiu) — assume
      } else {
        knownStations.set(sid, { label: String(label || sid).slice(0, 60), lastSeen: Date.now() }); // viva, mas não é a ativa agora
      }
      return sendJSON(res, 200, { ok: true, active: activeStation.stationId === sid, activeStationId: activeStation.stationId, activeLabel: activeStation.label });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/print-station/status — consulta simples do estado atual da Estação Ativa de
  // Impressão (v90). Usado pelo indicador 🟢/🔴 no Painel (Central de Impressão) e pelo Agente
  // Local, que consulta isso periodicamente pra decidir se ele mesmo está autorizado a
  // imprimir antes de cada tentativa (ver STATION_ID/isAuthorizedToPrint() em print-agent.js).
  if (pathname === '/api/print-station/status' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, {
      active: isActiveStationAlive(),
      activeStationId: activeStation ? activeStation.stationId : null,
      activeLabel: activeStation ? activeStation.label : null
    });
  }

  // ── POST /api/print — imprime a via de uma estação para um pedido ──
  if (pathname === '/api/print' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { orderId, station, auto, originId, stationId } = await readBody(req);
      const { cfg } = readConfig();
      // v49 — BUG CORRIGIDO ("impressora não imprime" em vias novas): essa checagem só aceitava
      // as 4 vias originais — qualquer via nova (delivery, expedição, ou uma via customizada
      // criada pelo admin) caía nesse "Via inválida" e nunca imprimia nada, mesmo com tudo
      // configurado certinho em Estações de Impressão. Agora aceita qualquer via que exista de
      // fato em cfg.stations.
      const st = Object.keys(cfg.stations || {}).includes(station) ? station : null;
      if (!st) return sendJSON(res, 400, { error: 'Via inválida.' });
      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJSON(res, 404, { error: 'Pedido não encontrado.' });

      const isCaixa = st === 'caixa';
      // v129 — NOVO ("via do motoboy/expedição deve focar em cliente/endereço/pagamento, não
      // na lista de itens como cozinha/sushibar"): ver DEFAULT_CFG.stations.delivery/expedicao
      // acima — qualquer via marcada com kind:'dispatch' usa o layout de despacho (mesmos
      // dados de entrega do Caixa, sem lista de itens) em vez do layout de produção.
      const isDispatch = !isCaixa && !!(cfg.stations[st] && cfg.stations[st].kind === 'dispatch');

      // v106 — REMOVIDO: a trava "só a Estação Ativa pode imprimir" (v90) que existia aqui.
      // Motivo: ela bloqueava IMPRESSÃO MANUAL (clique em Imprimir/Reimprimir, inclusive do
      // celular) sempre que o dispositivo que clicou não era o "painel mais recentemente
      // aberto" em QUALQUER computador do sistema — mesmo pra uma via de uma estação
      // totalmente diferente. Isso contraria diretamente o pedido de várias estações/
      // dispositivos simultâneos (v106 #1/#7/#8: impressão manual sempre deve funcionar). A
      // proteção contra duplicidade que essa trava também tentava dar pro caminho automático
      // já é feita corretamente logo abaixo (order.autoPrinted, por pedido+via, não por
      // dispositivo) — e o caminho automático do Agente Local (método "automatica") agora usa
      // POST /api/print-agent/claim, com a mesma garantia. O conceito de "Estação Ativa"
      // (GET /api/print-station/status, indicador 🟢/🔴) continua existindo normalmente pro
      // painel mostrar status — só não bloqueia mais impressão.

      // v50: via desativada (Configurações → 📠 Impressoras por Estação → impressora
      // temporariamente fora do ar) — pula de propósito, sem tentar imprimir e sem erro. Igual
      // ao caso de "sem itens pra essa via", só que por escolha do admin em vez de automático.
      if (cfg.stations[st] && cfg.stations[st].active === false) {
        return sendJSON(res, 200, { ok: true, printed: false, skipped: true, disabled: true, order, station: st });
      }

      // Caixa: comprovante completo (todos os itens + dados do cliente + horário).
      // Despacho (delivery/expedição): dados de entrega do Caixa, sem lista de itens — quem
      // sai pra entregar não precisa conferir prato por prato, só pra onde ir e quanto cobrar.
      // Cozinha/Sushibar/Bar: só os itens daquela estação + observações, sem dados pessoais.
      const items = (isCaixa || isDispatch) ? order.items : order.items.filter(i => (i.stations || []).includes(st));
      // v129: via de despacho só faz sentido pra pedido DELIVERY (retirada não tem motoboy pra
      // avisar) — pula sem erro, igual já acontece quando uma via de produção não tem itens.
      if (isDispatch && order.mode !== 'delivery') return sendJSON(res, 200, { ok: true, printed: false, skipped: true, order, station: st });
      if (!isDispatch && !items.length) return sendJSON(res, 200, { ok: true, printed: false, skipped: true, order, station: st });

      // v86 — CORRIGIDO ("imprimiu 3 cópias da mesma via"): cfg.print (auto-impressão) é um
      // interruptor GLOBAL — todo painel aberto e conectado, em qualquer aparelho (ou aba),
      // dispara seu PRÓPRIO printOrder() sozinho assim que um pedido novo chega. Nada impedia
      // isso: com 2 ou 3 painéis abertos ao mesmo tempo (2 abas no mesmo PC, ou vários
      // aparelhos com "Terminal de Impressão" marcado), CADA um mandava seu próprio
      // POST /api/print pra cada via, e nenhum sabia que os outros já tinham cuidado do mesmo
      // pedido — resultado: a mesma via saía 2, 3 vezes seguidas. Agora, só pra disparos
      // AUTOMÁTICOS (auto:true — nunca pra clique manual de "Imprimir"/reimpressão, que sempre
      // deve funcionar quando pedido de propósito, inclusive o seletor de vias da v86), o
      // servidor marca no próprio pedido (order.autoPrinted) qual via já processou o
      // auto-print; qualquer segunda chamada automática pra essa MESMA via desse MESMO pedido
      // é ignorada, não importa de quantos painéis abertos ela venha.
      if (auto) {
        const now=Date.now(); const leaseMs=90000;
        if(!order.autoPrintState) order.autoPrintState={};
        const state=order.autoPrintState[st];
        if(order.autoPrinted?.[st] || state?.status==='done') return sendJSON(res,200,{ok:true,printed:false,skipped:true,alreadyAutoPrinted:true,order,station:st});
        if(state?.status==='printing' && now-Number(state.claimedAt||0)<leaseMs) return sendJSON(res,200,{ok:true,printed:false,skipped:true,alreadyAutoPrinting:true,order,station:st});
        order.autoPrintState[st]={status:'printing',claimedAt:now,owner:String(stationId||originId||'panel').slice(0,120)};
        const idx = orders.findIndex(o => o.id === order.id); if(idx>-1) orders[idx]=order; writeJSON(ORDERS_FILE,orders);
      } else if (!order.autoPrintState || !order.autoPrintState[st]) {
        // v132 — BUG CORRIGIDO ("vias imprimindo duplicado ao clicar"): a trava acima (v86)
        // só valia pra disparo AUTOMÁTICO, de propósito — reimpressão manual sempre deveria
        // funcionar sem trava nenhuma (v106), pra staff poder forçar reimpressão de uma via
        // que travou/errou. Só que isso deixava uma brecha real: se DOIS aparelhos (ex.:
        // celular + tablet, os dois com o painel de um pedido NOVO aberto) clicassem
        // "🖨 Imprimir" quase ao mesmo tempo, os dois cliques manuais passavam direto sem
        // trava nenhuma — a mesma via saía impressa 2 vezes. Agora aplica essa MESMA trava de
        // 90s (idêntica à automática), só que É SÓ PRA PRIMEIRA VEZ — se essa via NUNCA foi
        // impressa nesse pedido (nem automático nem manual, `autoPrintState[st]` não existe),
        // protege contra o clique duplicado de dois aparelhos. Assim que existe QUALQUER
        // registro pra essa via — mesmo que tenha sido só essa primeira trava, sem nunca ter
        // sido marcado "done" — os próximos cliques manuais (reimpressão deliberada, minutos
        // ou horas depois) pulam esse bloco inteiro e imprimem sem nenhum bloqueio, igual
        // sempre funcionou. Ou seja: protege só a corrida do primeiro clique, nunca atrapalha
        // uma reimpressão de propósito.
        const now=Date.now(); const leaseMs=90000;
        if(!order.autoPrintState) order.autoPrintState={};
        const state=order.autoPrintState[st];
        if(state?.status==='printing' && now-Number(state.claimedAt||0)<leaseMs) return sendJSON(res,200,{ok:true,printed:false,skipped:true,alreadyPrinting:true,order,station:st});
        order.autoPrintState[st]={status:'printing',claimedAt:now,owner:String(stationId||originId||'panel').slice(0,120)};
        const idx = orders.findIndex(o => o.id === order.id); if(idx>-1) orders[idx]=order; writeJSON(ORDERS_FILE,orders);
      }

      const deliveryWindow = estimateDeliveryWindow(order, cfg);
      let printerCfg = cfg.stations[st] || { method: 'navegador' };
      // v39 (pedido novo): se a via não tem impressora própria configurada (USB/rede), em vez
      // de falhar, imprime na MESMA impressora USB/rede já configurada pro Caixa — assim uma
      // única impressora física dá conta de todas as vias até que cada uma ganhe a sua.
      let usedCaixaFallback = false;
      const missingOwnPrinter = !isCaixa && (
        (printerCfg.method === 'usb' && !printerCfg.device) ||
        (printerCfg.method === 'rede' && !printerCfg.ip)
      );
      if (missingOwnPrinter) {
        const caixaCfg = cfg.stations.caixa;
        const caixaReady = caixaCfg && ((caixaCfg.method === 'usb' && caixaCfg.device) || (caixaCfg.method === 'rede' && caixaCfg.ip));
        if (caixaReady) { printerCfg = caixaCfg; usedCaixaFallback = true; }
      }
      if (printerCfg.method === 'navegador') {
        // v83: "app no celular como controle remoto" — clicar em Imprimir no celular só
        // abria a janela de impressão NO PRÓPRIO CELULAR (inútil, celular não tem a impressora
        // térmica ligada nele). Agora, além de responder pro aparelho que clicou (que continua
        // imprimindo normalmente, se ele mesmo estiver com um terminal aberto), avisa por SSE
        // TODOS os outros paineis abertos — qualquer computador marcado como "🖥️ Terminal de
        // Impressão" (Central de Impressão → checkbox, fica salvo só naquele aparelho) escuta
        // esse aviso e imprime sozinho, sem ninguém precisar tocar em nada nele. `originId`
        // evita o aparelho que clicou imprimir a MESMA via duas vezes (uma pelo fluxo normal,
        // outra pelo aviso remoto que ele mesmo geraria).
        if (!auto) broadcast('print-order-remote', { order, station: st, deliveryWindow, originId: originId || undefined });
        // O navegador do cliente (painel) monta e imprime o ticket — servidor só confirma os dados.
        return sendJSON(res, 200, { ok: true, printed: false, order, station: st, method: 'navegador', deliveryWindow });
      }
      // v46 — BUG CORRIGIDO ("impressora deve imprimir automaticamente sem navegar sem
      // confirmação"): a raiz do problema é que um navegador NUNCA consegue mandar pra
      // impressora sem abrir alguma janela e pedir confirmação — isso é uma trava de
      // segurança do próprio navegador, nenhum código de site consegue contornar isso sozinho.
      // A única forma real de "imprime sozinho, sem clicar em nada" é ter um programinha rodando
      // no computador da loja que fala direto com a impressora — é o que o método "Automática"
      // faz: delega pro Agente Local de Impressão (print-agent/), que já está escutando os
      // pedidos novos em tempo real e imprime sozinho, sem qualquer participação do navegador.
      if (printerCfg.method === 'automatica') {
        // v54 — BUG CORRIGIDO ("imprimir via celular não chega na impressora do PC"): até
        // aqui, clicar em "🖨 Imprimir" (seja de novo, seja reimprimindo) numa via
        // Automática só devolvia `delegated:true` pro navegador SEM avisar o Agente Local
        // de verdade — o agente só imprimia pedido novo automaticamente na hora da criação
        // (evento "new-order"); qualquer clique manual depois disso (do celular, do PC, de
        // qualquer painel logado) não tinha efeito nenhum na impressora, mesmo mostrando um
        // aviso de "enviado". Agora todo clique manual manda um evento "print-order" por SSE
        // pra TODOS os clientes conectados (painel no PC, painel no celular, Agente Local) —
        // é assim que "celular manda, impressora do PC obedece" funciona de verdade: o
        // servidor é o intermediário, o Agente Local (rodando no PC ligado na impressora)
        // escuta esse evento e imprime na hora, não importa de qual aparelho o pedido partiu.
        //
        // v55 — BUG CORRIGIDO (impressão em dobro): quando um painel fica aberto com
        // "imprimir automaticamente ao chegar pedido novo" ligado, ele mesmo chama essa rota
        // assim que o pedido chega — mas o Agente Local JÁ recebeu e imprimiu esse pedido
        // diretamente pelo evento "new-order" (é o caminho normal dele, não depende dessa
        // rota). Sem essa checagem, o painel aberto mandava um SEGUNDO aviso ("print-order")
        // pro mesmo agente, que imprimia tudo de novo — duplicando toda comanda. Agora, só
        // quando é esse disparo automático (`auto:true`, mandado só nesse caso específico
        // pelo painel.html), pula o aviso extra; um clique manual de "Imprimir"/"Reimprimir"
        // continua avisando o agente normalmente, porque aí é uma reimpressão de verdade,
        // pedida de propósito, e não tem nenhum outro caminho já cuidando dela.
        if (!auto) broadcast('print-order', { order, station: st });
        return sendJSON(res, 200, { ok: true, printed: false, delegated: true, order, station: st, method: 'automatica' });
      }

      // v44: layout ESC/POS redesenhado — cabeçalho centralizado, blocos com título
      // (CLIENTE/ITENS/RESUMO no comprovante; HORÁRIOS/ITENS na via de produção), valores
      // alinhados à direita (padStart até a largura configurada — ver printCols() acima),
      // TOTAL em destaque. Sem emoji no ESC/POS puro (impressora térmica não garante suporte
      // a eles); o emoji fica só na via impressa pelo navegador (openBrowserTicket, no
      // painel.html).
      // v126 — BUG CORRIGIDO ("ajuste pra caber na bobina 80mm"): esse 32 aqui era FIXO,
      // sempre — certo pra 58mm, mas deixava uma bobina de 80mm com metade da largura sem
      // uso. Agora usa printCols(cfg), que respeita cfg.printWidth (Configurações → Central
      // de Impressão → Fonte de Impressão → Largura da bobina).
      const cols = printCols(cfg);
      const HR = '-'.repeat(cols);
      const HR2 = '='.repeat(cols);
      // v128 — usado só nas linhas de nome do item (ver items.forEach mais abaixo) — reaproveita
      // o mesmo cálculo do buildTicketText, então "wideOn" já parte do tamanho configurado em
      // Fonte de Impressão, só com a largura +1 nível.
      const tamItem = tamanhoImpressaoTermica(cfg.printSize);
      const money = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
      const rightAlignRow = (label, value) => {
        const pad = Math.max(1, cols - label.length - value.length);
        return label + ' '.repeat(pad) + value;
      };
      const refShort = String(order.id || '').slice(-11).toUpperCase();
      const lines = [];
      // v131 — NOVO VISUAL DO COMPROVANTE (só layout — nenhuma lógica de impressão, fila,
      // anti-duplicação, ESC/POS de corte/bipe/código-de-página ou comunicação com impressora
      // foi tocada aqui, só o TEXTO/formatação das linhas do corpo do ticket): cabeçalho
      // agora emoldurado por linhas duplas em cima E embaixo (era só embaixo), pedido de um
      // visual mais "premium/minimalista" inspirado em comprovante de restaurante japonês.
      lines.push(HR2);
      // v133 — BUG CORRIGIDO ("cabeçalho deve ter apenas Shogatsu Culinária Oriental"): a
      // linha de subtítulo (cfg.tagline, padrão "CULINARIA ORIENTAL") aparecia LOGO ABAIXO do
      // nome da loja — se o nome já configurado em cfg.name for "Shogatsu Culinária Oriental"
      // (como é o caso aqui), o cabeçalho saía com o nome inteiro e, na linha de baixo, uma
      // repetição de parte dele ("CULINÁRIA ORIENTAL" de novo). Cabeçalho agora mostra só o
      // nome da loja (cfg.name), uma vez só — sem linha de subtítulo separada.
      lines.push(ESC.center + ESC.boldOn + (cfg.name || 'SHOGATSU').toUpperCase() + ESC.boldOff + ESC.left);
      lines.push(HR2);
      lines.push('');
      // v131: "PEDIDO #" é o elemento mais destacado do ticket inteiro (pedido explícito do
      // novo layout) — maior + negrito, centralizado, sozinho na própria linha.
      lines.push(ESC.center + ESC.boldOn + tamItem.wideOn + (order.ticketNumber ? 'PEDIDO Nº ' + order.ticketNumber : 'PEDIDO #' + order.id) + tamItem.on + ESC.boldOff + ESC.left);
      lines.push('');

      if (isCaixa) {
        // ── Via do Caixa: comprovante completo (dados do cliente + horário estimado) ──
        // v131 — NOVO VISUAL (só formatação/ordem das linhas — nenhum dado novo, nenhum
        // cálculo novo, nenhuma lógica de impressão mudou): layout "premium minimalista"
        // pedido, agrupado por finalidade (DATA/HORA/TIPO, ITENS, OBSERVAÇÃO, CLIENTE/
        // TELEFONE/ENDEREÇO, PAGAMENTO+TOTAL), com separadores simples e o nome dos produtos
        // maior e em negrito — mesmo tratamento que a via de produção já ganhou na v128.
        // "Ref.: #" (código curto) saiu do topo pra não competir visualmente com "PEDIDO #"
        // (agora o elemento mais destacado, no cabeçalho compartilhado acima) — continua
        // disponível, só que junto do resumo de pagamento no rodapé, onde ainda serve pra
        // conferência sem disputar atenção com o número do pedido.
        lines.push(HR);
        lines.push('DATA: ' + new Date(order.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
        lines.push('HORA: ' + new Date(order.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }));
        lines.push('TIPO: ' + (order.mode === 'delivery' ? 'DELIVERY' : 'RETIRADA'));
        lines.push(HR);
        lines.push('');
        items.forEach(i => {
          lines.push(`${i.qty}x  ` + ESC.boldOn + tamItem.wideOn + i.name + tamItem.on + ESC.boldOff);
        });
        lines.push(HR);
        if (order.obs) {
          lines.push('');
          lines.push(ESC.boldOn + 'OBSERVACAO' + ESC.boldOff);
          lines.push(order.obs);
          lines.push(HR);
        }
        lines.push('');
        lines.push(ESC.boldOn + 'CLIENTE' + ESC.boldOff);
        lines.push(order.name);
        lines.push('');
        lines.push(ESC.boldOn + 'TELEFONE' + ESC.boldOff);
        lines.push(order.phone);
        if (order.mode === 'delivery') {
          lines.push('');
          lines.push(ESC.boldOn + 'ENDERECO' + ESC.boldOff);
          lines.push(order.address);
        }
        lines.push((order.mode === 'delivery' ? 'Previsao: ' : 'Previsao retirada: ') + deliveryWindow + '   Ref.: #' + refShort);
        lines.push(HR);
        lines.push('');
        lines.push(ESC.boldOn + 'PAGAMENTO' + ESC.boldOff);
        lines.push(payMethodTicketLabel(order) + (order.troco ? ' (troco para ' + order.troco + ')' : ''));
        lines.push('');
        lines.push(rightAlignRow('Subtotal', money(order.subtotal)));
        lines.push(rightAlignRow('Entrega', money(order.fee)));
        if (order.discount > 0 || order.couponCode) {
          lines.push(rightAlignRow(`Cupom ${order.couponCode}`, '-' + money(order.discount || 0)));
        }
        lines.push('');
        lines.push(ESC.boldOn + 'TOTAL' + ESC.boldOff);
        lines.push(ESC.boldOn + tamItem.wideOn + money(order.total) + tamItem.on + ESC.boldOff);
        lines.push(HR2);
        lines.push('');
        // v133 — BUG CORRIGIDO ("rodapé deve ter apenas Obrigado pela Preferência"): antes
        // repetia "OBRIGADO!" + o nome da loja de novo (redundante — o nome já aparece bem
        // no topo do ticket). Volta pra uma linha só, direta.
        lines.push(ESC.center + ESC.boldOn + 'OBRIGADO PELA PREFERENCIA!' + ESC.boldOff + ESC.left);
        lines.push(HR2);
        if (cfg.siteUrl) { lines.push(''); lines.push(ESC.center + cfg.siteUrl + ESC.left); }
      } else if (isDispatch) {
        // v129 — NOVO ("via do motoboy/expedição deve focar em cliente/endereço/pagamento"):
        // mesmo bloco de dados de entrega do Caixa (endereço, pagamento, troco), sem a lista
        // de itens — quem vai entregar não precisa conferir prato por prato, só pra onde ir e
        // quanto cobrar/receber. Reaproveita os mesmos campos do pedido que o Caixa já usa
        // (order.address, order.courierName etc.) — não inventa estrutura de dado nova.
        lines.push(ESC.center + ESC.boldOn + ((cfg.stations[st] && cfg.stations[st].label) || st).toUpperCase() + ESC.boldOff + ESC.left);
        lines.push(ESC.center + 'VIA DE DESPACHO' + ESC.left);
        lines.push(HR);
        lines.push('Ref.: #' + refShort);
        lines.push(HR);
        lines.push(ESC.boldOn + 'CLIENTE' + ESC.boldOff);
        lines.push(HR);
        lines.push(order.name);
        lines.push('Tel: ' + order.phone);
        lines.push(HR);
        lines.push(ESC.boldOn + 'ENDERECO' + ESC.boldOff);
        lines.push(HR);
        lines.push(order.address || '—');
        lines.push(HR);
        lines.push(ESC.boldOn + 'PAGAMENTO' + ESC.boldOff);
        lines.push(HR);
        lines.push(payMethodTicketLabel(order));
        lines.push(rightAlignRow('Total:', money(order.total)));
        if (order.troco) lines.push(rightAlignRow('Troco para:', String(order.troco)));
        lines.push(HR);
        lines.push(rightAlignRow('Taxa de entrega:', money(order.fee)));
        lines.push(rightAlignRow('Motoboy:', order.courierName || 'A definir'));
        lines.push(rightAlignRow('Previsao entrega:', deliveryWindow));
        if (order.obs) { lines.push(HR); lines.push(ESC.boldOn + 'OBSERVACAO' + ESC.boldOff); lines.push(order.obs); }
        lines.push(HR2);
      } else {
        // ── Vias de produção (cozinha/sushibar/bar): layout idêntico entre as três vias ──
        // v40: previsão de saída automática = Entrada + tempo de preparo configurado pra essa estação.
        const prepMin = Number((cfg.stations[st] && cfg.stations[st].prepTime)) || 15;
        const entrada = new Date(order.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        const saidaPrevista = new Date(new Date(order.createdAt).getTime() + prepMin * 60000)
          .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        lines.push(ESC.center + ESC.boldOn + ((cfg.stations[st] && cfg.stations[st].label) || st).toUpperCase() + ESC.boldOff);
        lines.push('VIA DE PRODUCAO' + ESC.left);
        lines.push(HR);
        lines.push('Ref.: #' + refShort);
        lines.push(order.mode === 'delivery' ? 'DELIVERY' : 'RETIRADA');
        lines.push(HR);
        lines.push(ESC.boldOn + 'HORARIOS' + ESC.boldOff);
        lines.push(HR);
        lines.push(rightAlignRow('Entrada:', entrada));
        lines.push(rightAlignRow('Tempo de preparo:', prepMin + ' min'));
        lines.push(rightAlignRow('Saida Prevista:', saidaPrevista));
        // v88 — CORRIGIDO: as vias de produção (Cozinha/Sushibar/Bar/etc) só mostravam o
        // horário de saída da PRÓPRIA via, mas não a previsão de entrega/retirada do pedido
        // inteiro (isso só saía na via do Caixa) — quem tá preparando o prato não tinha como
        // saber se o pedido é pra já ou se tem uma previsão de entrega mais folgada. Agora
        // mostra as duas linhas, igual já aparece na página de Pedidos do painel.
        lines.push(rightAlignRow(order.mode === 'delivery' ? 'Prev. entrega:' : 'Prev. retirada:', deliveryWindow));
        // v129 — NOVO ("níveis de prioridade NORMAL/ATENÇÃO/ATRASADO"): só aparece quando o
        // pedido JÁ está atrasado ou perto de atrasar em relação à Saída Prevista DESSA via —
        // relevante principalmente em reimpressão manual de um pedido represado (a impressão
        // automática sai muito perto da criação do pedido, quase sempre "NORMAL" — imprimir
        // essa palavra toda vez seria só desperdiçar papel à toa). Sem depender só de emoji
        // (impressora térmica às vezes não imprime emoji) — o texto "ATRASADO"/"ATENCAO" vem
        // sempre junto.
        {
          const saidaMs = new Date(order.createdAt).getTime() + prepMin * 60000;
          const atraso = Date.now() - saidaMs;
          if (atraso >= 0) lines.push(HR2 + '\n' + ESC.center + ESC.boldOn + '*** ATRASADO ***' + ESC.boldOff + ESC.left + '\n' + HR2);
          else if (atraso >= -5 * 60000) lines.push(HR + '\n' + ESC.center + ESC.boldOn + '** ATENCAO — QUASE NA HORA **' + ESC.boldOff + ESC.left + '\n' + HR);
        }
        lines.push(HR);
        lines.push(ESC.boldOn + ('ITENS DA ' + (((cfg.stations[st] && cfg.stations[st].label) || st).toUpperCase())) + ESC.boldOff);
        lines.push(HR);
        // v128 — NOVO ("nome do item deve ser maior e em negrito na comanda da cozinha e
        // sushibar pra melhor visualização"): só na via de PRODUÇÃO (cozinha/sushibar/etc,
        // não no comprovante do caixa) — quem está preparando o prato precisa bater o olho e
        // reconhecer o item rápido, sem ter que ler letrinha miúda no meio da correria.
        // Quantidade fica normal (bold sozinho já chama atenção o suficiente sem quebrar a
        // linha) e só o NOME do item vem maior (largura dobrada) + negrito.
        items.forEach(i => lines.push('* ' + i.qty + 'x ' + ESC.boldOn + tamItem.wideOn + i.name + tamItem.on + ESC.boldOff));
        lines.push(HR);
        lines.push('Observacoes:');
        if (order.obs) lines.push(order.obs);
        else { lines.push('_______________________________'); lines.push('_______________________________'); }
      }
      lines.push(HR2);
      const ticketText = buildTicketText(lines, cfg);

      try {
        if (printerCfg.method === 'rede') {
          if (!printerCfg.ip) { if(auto){try{const fresh=readJSON(ORDERS_FILE);const oi=fresh.findIndex(o=>o.id===order.id);if(oi>-1){delete (fresh[oi].autoPrintState||{})[st];writeJSON(ORDERS_FILE,fresh);}}catch(e){}} return sendJSON(res, 400, { error: `Impressora de rede da via "${st}" sem IP configurado.`, retryable:true }); }
          await sendNetworkPrint(printerCfg.ip, printerCfg.port, ticketText);
        } else if (printerCfg.method === 'usb') {
          if (!printerCfg.device) { if(auto){try{const fresh=readJSON(ORDERS_FILE);const oi=fresh.findIndex(o=>o.id===order.id);if(oi>-1){delete (fresh[oi].autoPrintState||{})[st];writeJSON(ORDERS_FILE,fresh);}}catch(e){}} return sendJSON(res, 400, { error: `Caminho do dispositivo USB da via "${st}" não configurado.`, retryable:true }); }
          await sendUSBPrint(printerCfg.device, ticketText);
        }
        // v132 — antes só marcava "done" pra auto (`if(auto)`); a trava do primeiro-clique
        // manual (ver bloco acima) também precisa fechar o ciclo, senão ficaria presa em
        // "printing" pra sempre (sem travar reimpressão — isso já não trava, ver comentário
        // acima — mas deixaria o estado incorreto pra quem for conferir o log depois).
        { const fresh=readJSON(ORDERS_FILE); const oi=fresh.findIndex(o=>o.id===order.id); if(oi>-1){fresh[oi].autoPrintState=fresh[oi].autoPrintState||{};fresh[oi].autoPrintState[st]={status:'done',finishedAt:new Date().toISOString()};if(auto){fresh[oi].autoPrinted=fresh[oi].autoPrinted||{};fresh[oi].autoPrinted[st]=true;}writeJSON(ORDERS_FILE,fresh);} }
        return sendJSON(res, 200, { ok: true, printed: true, order, station: st, method: printerCfg.method, usedCaixaFallback });
      } catch (printErr) {
        if(auto){ try{const fresh=readJSON(ORDERS_FILE);const oi=fresh.findIndex(o=>o.id===order.id);if(oi>-1){fresh[oi].autoPrintState=fresh[oi].autoPrintState||{};delete fresh[oi].autoPrintState[st];if(fresh[oi].autoPrinted)delete fresh[oi].autoPrinted[st];writeJSON(ORDERS_FILE,fresh);}}catch(e){} }
        // v132: mesma limpeza acima, agora também pro clique manual — se a primeira tentativa
        // falhar (impressora offline etc.), libera a trava na hora em vez de deixar presa 90s
        // à toa (staff geralmente tenta de novo na sequência, não faz sentido segurar).
        else { try{const fresh=readJSON(ORDERS_FILE);const oi=fresh.findIndex(o=>o.id===order.id);if(oi>-1 && fresh[oi].autoPrintState){delete fresh[oi].autoPrintState[st];writeJSON(ORDERS_FILE,fresh);}}catch(e){} }
        try{const log=readJSON(PRINT_LOG_FILE);log.unshift({orderId,station,error:String(printErr.message||printErr).slice(0,500),ts:new Date().toISOString(),retryable:true,method:printerCfg.method});fs.writeFileSync(PRINT_LOG_FILE,JSON.stringify(log.slice(0,500),null,2));}catch(e){}
        return sendJSON(res, 502, { error: `Falha ao imprimir na via "${st}": ${printErr.message}`, retryable:true });
      }
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/print-test — envia um ticket de teste para a impressora de uma via ──
  if (pathname === '/api/print-test' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { station } = await readBody(req);
      const { cfg } = readConfig();
      const printerCfg = cfg.stations[station];
      if (!printerCfg) return sendJSON(res, 400, { error: 'Via inválida.' });
      if (printerCfg.active === false) return sendJSON(res, 400, { error: 'Essa via está desativada — ative em Configurações → 📠 Impressoras por Estação pra poder testar.' });
      if (printerCfg.method === 'navegador') return sendJSON(res, 200, { ok: true, method: 'navegador' });
      const text = buildTicketText([
        ESC.center + ESC.boldOn + 'TESTE DE IMPRESSAO' + ESC.boldOff + ESC.left,
        'Via: ' + (printerCfg.label || station),
        new Date().toLocaleString('pt-BR')
      ], cfg);
      if (printerCfg.method === 'automatica') {
        // v46: não tem como o servidor (na nuvem) mandar isso direto pra impressora — quem
        // imprime é o Agente Local, que fica escutando esse evento também (junto com
        // "new-order") e imprime sozinho assim que o administrador clica em "Testar".
        broadcast('print-test', { station, text, label: printerCfg.label || station, fontSize: cfg.printSize });
        return sendJSON(res, 200, { ok: true, method: 'automatica', delegated: true });
      }
      if (printerCfg.method === 'rede') {
        if (!printerCfg.ip) return sendJSON(res, 400, { error: 'Informe o IP da impressora.' });
        await sendNetworkPrint(printerCfg.ip, printerCfg.port, text);
      } else if (printerCfg.method === 'usb') {
        if (!printerCfg.device) return sendJSON(res, 400, { error: 'Informe o caminho do dispositivo USB.' });
        await sendUSBPrint(printerCfg.device, text);
      }
      return sendJSON(res, 200, { ok: true, printed: true });
    } catch (e) { return sendJSON(res, e.message && e.code ? 502 : 400, { error: e.message || 'invalid body' }); }
  }

  // ── POST /api/customer/register — cliente cria conta (telefone + senha de 4 dígitos) ──
  if (pathname === '/api/customer/register' && req.method === 'POST') {
    try {
      const { phone, name, pin } = await readBody(req);
      const p = normalizePhone(phone);
      if (p.length < 10) return sendJSON(res, 400, { error: 'Telefone inválido.' });
      if (!/^\d{4}$/.test(String(pin || ''))) return sendJSON(res, 400, { error: 'A senha precisa ter exatamente 4 dígitos.' });
      if (!name || !name.trim()) return sendJSON(res, 400, { error: 'Informe seu nome.' });

      const customers = readJSON(CUSTOMERS_FILE);
      let customer = findCustomer(customers, p);
      if (customer) return sendJSON(res, 409, { error: 'Já existe uma conta com esse telefone. Use "Entrar" ou "Esqueci minha senha".' });

      customer = {
        phone: p, name: String(name).trim().slice(0, 80),
        pinHash: hashPin(p, pin), createdAt: new Date().toISOString(),
        lastAddress: null, recovery: null
      };
      customers.push(customer);
      writeJSON(CUSTOMERS_FILE, customers);
      return sendJSON(res, 201, { ok: true, customer: { phone: customer.phone, name: customer.name, lastAddress: null } });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/customer/login — cliente entra com telefone + senha de 4 dígitos ──
  if (pathname === '/api/customer/login' && req.method === 'POST') {
    try {
      const { phone, pin } = await readBody(req);
      const p = normalizePhone(phone);
      const customers = readJSON(CUSTOMERS_FILE);
      const customer = findCustomer(customers, p);
      if (!customer || customer.pinHash !== hashPin(p, pin)) return sendJSON(res, 401, { error: 'Telefone ou senha incorretos.' });
      const orders = readJSON(ORDERS_FILE);
      const stats = customerStats(p, orders);
      const { cfg } = readConfig();
      const loyalty = loyaltyBalance(p, orders, cfg);
      return sendJSON(res, 200, { ok: true, customer: { phone: customer.phone, name: customer.name, lastAddress: customer.lastAddress, ...stats, loyaltyPoints: loyalty.balance } });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/customer/recovery-request — gera código e devolve link do WhatsApp da loja ──
  if (pathname === '/api/customer/recovery-request' && req.method === 'POST') {
    try {
      const { phone } = await readBody(req);
      const p = normalizePhone(phone);
      const customers = readJSON(CUSTOMERS_FILE);
      const customer = findCustomer(customers, p);
      if (!customer) return sendJSON(res, 404, { error: 'Não existe conta com esse telefone.' });

      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
      customer.recovery = { code, requestedAt: new Date().toISOString(), approved: false };
      writeJSON(CUSTOMERS_FILE, customers);

      const { cfg } = readConfig();
      const waText = `Olá! Quero recuperar minha senha do Shogatsu.\nMeu telefone: ${customer.phone}\nCódigo: ${code}`;
      const waUrl = `https://wa.me/${cfg.whats}?text=${encodeURIComponent(waText)}`;
      return sendJSON(res, 200, { ok: true, code, waUrl });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/customer/recovery-set-pin — cliente define nova senha (precisa já ter sido aprovado no painel) ──
  if (pathname === '/api/customer/recovery-set-pin' && req.method === 'POST') {
    try {
      const { phone, code, newPin } = await readBody(req);
      const p = normalizePhone(phone);
      if (!/^\d{4}$/.test(String(newPin || ''))) return sendJSON(res, 400, { error: 'A nova senha precisa ter exatamente 4 dígitos.' });
      const customers = readJSON(CUSTOMERS_FILE);
      const customer = findCustomer(customers, p);
      if (!customer || !customer.recovery || customer.recovery.code !== String(code)) {
        return sendJSON(res, 400, { error: 'Código inválido.' });
      }
      if (!customer.recovery.approved) {
        return sendJSON(res, 403, { error: 'Ainda aguardando a confirmação da loja pelo WhatsApp. Tente novamente em instantes.' });
      }
      customer.pinHash = hashPin(p, newPin);
      customer.recovery = null;
      writeJSON(CUSTOMERS_FILE, customers);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/admin/customers/orders?phone=... — histórico de pedidos de um cliente ──
  if (pathname === '/api/admin/customers/orders' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const p = normalizePhone(query.phone);
    const orders = readJSON(ORDERS_FILE).filter(o => normalizePhone(o.phone) === p);
    return sendJSON(res, 200, { orders });
  }

  // ── GET /api/loyalty?phone=... — saldo de pontos de fidelidade do cliente (público, mesmo padrão de identificação por telefone já usado no resto do app) ──
  if (pathname === '/api/loyalty' && req.method === 'GET') {
    const { cfg } = readConfig();
    const phone = query.phone || '';
    if (!cfg.loyalty || !cfg.loyalty.enabled) return sendJSON(res, 200, { enabled: false });
    const orders = readJSON(ORDERS_FILE);
    const bal = loyaltyBalance(phone, orders, cfg);
    return sendJSON(res, 200, { enabled: true, ...bal, config: cfg.loyalty });
  }

  // ── POST /api/admin/customers/recovery-approve — restaurante confirma o código recebido no WhatsApp ──
  if (pathname === '/api/admin/customers/recovery-approve' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { phone } = await readBody(req);
      const p = normalizePhone(phone);
      const customers = readJSON(CUSTOMERS_FILE);
      const customer = findCustomer(customers, p);
      if (!customer || !customer.recovery) return sendJSON(res, 404, { error: 'Nenhuma recuperação pendente pra esse telefone.' });
      customer.recovery.approved = true;
      writeJSON(CUSTOMERS_FILE, customers);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/customer/orders?phone=...&pin=... — o PRÓPRIO cliente vê seu histórico de pedidos
  // (usado na tela "Minha Conta"). Exige telefone + senha (mesma checagem do login) — não é público
  // como o /api/loyalty, porque o histórico expõe endereço e itens comprados.
  if (pathname === '/api/customer/orders' && req.method === 'GET') {
    const p = normalizePhone(query.phone);
    const customers = readJSON(CUSTOMERS_FILE);
    const customer = findCustomer(customers, p);
    if (!customer || customer.pinHash !== hashPin(p, query.pin)) return sendJSON(res, 401, { error: 'Não autorizado.' });
    const orders = readJSON(ORDERS_FILE).filter(o => normalizePhone(o.phone) === p)
      .map(o => ({ id: o.id, ticketNumber: o.ticketNumber, createdAt: o.createdAt, status: o.status, items: o.items, total: o.total, mode: o.mode, payMethod: o.payMethod }));
    return sendJSON(res, 200, { orders });
  }

  // ── GET /api/customer/reservations — v94: cliente vê as PRÓPRIAS reservas (mesmo padrão de
  // /api/customer/orders acima — telefone + senha de 4 dígitos). Faltava esse endpoint pra dar
  // pra montar a tela "Minhas Reservas" no app do cliente. ──
  if (pathname === '/api/customer/reservations' && req.method === 'GET') {
    const p = normalizePhone(query.phone);
    const customers = readJSON(CUSTOMERS_FILE);
    const customer = findCustomer(customers, p);
    if (!customer || customer.pinHash !== hashPin(p, query.pin)) return sendJSON(res, 401, { error: 'Não autorizado.' });
    const reservations = readJSON(RESERVATIONS_FILE).filter(r => normalizePhone(r.phone) === p)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJSON(res, 200, { reservations });
  }

  // ── POST /api/customer/update — cliente edita o próprio cadastro (nome / endereço salvo) ──
  if (pathname === '/api/customer/update' && req.method === 'POST') {
    try {
      const { phone, pin, name, lastAddress } = await readBody(req);
      const p = normalizePhone(phone);
      const customers = readJSON(CUSTOMERS_FILE);
      const customer = findCustomer(customers, p);
      if (!customer || customer.pinHash !== hashPin(p, pin)) return sendJSON(res, 401, { error: 'Não autorizado.' });
      if (name && name.trim()) customer.name = String(name).trim().slice(0, 80);
      if (lastAddress !== undefined) customer.lastAddress = lastAddress ? String(lastAddress).slice(0, 200) : customer.lastAddress;
      writeJSON(CUSTOMERS_FILE, customers);
      return sendJSON(res, 200, { ok: true, customer: { phone: customer.phone, name: customer.name, lastAddress: customer.lastAddress } });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ═══════════════════════════════════════════
  // NOTIFICAÇÕES PUSH (promoções/cupons/novidades) — VAPID + Web Push nativo, sem custo
  // ═══════════════════════════════════════════
  // ── GET /api/push/vapid-public-key — chave pública que o navegador do cliente precisa pra se inscrever ──
  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    const { cfg } = readConfig();
    return sendJSON(res, 200, { publicKey: cfg.vapid.publicKey });
  }
  // ── POST /api/push/subscribe — navegador do cliente se inscreve (telefone é opcional, usado pra segmentar) ──
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    try {
      const { subscription, phone } = await readBody(req);
      if (!subscription || !subscription.endpoint || !subscription.keys) return sendJSON(res, 400, { error: 'Inscrição inválida.' });
      const subs = readJSON(PUSH_SUBS_FILE);
      const existing = subs.findIndex(s => s.endpoint === subscription.endpoint);
      const entry = { endpoint: subscription.endpoint, keys: subscription.keys, phone: phone ? normalizePhone(phone) : '', createdAt: new Date().toISOString() };
      if (existing === -1) subs.push(entry); else subs[existing] = entry;
      writeJSON(PUSH_SUBS_FILE, subs);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/push/unsubscribe ──
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    try {
      const { endpoint } = await readBody(req);
      const subs = readJSON(PUSH_SUBS_FILE).filter(s => s.endpoint !== endpoint);
      writeJSON(PUSH_SUBS_FILE, subs);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── GET /api/admin/push-subscribers — quantos clientes têm push ativo (pra mostrar no painel) ──
  if (pathname === '/api/admin/push-subscribers' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'gerenciarInscritos')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const subs = readJSON(PUSH_SUBS_FILE);
    return sendJSON(res, 200, { total: subs.length, withPhone: subs.filter(s => s.phone).length });
  }
  // ── POST /api/admin/send-push — envia campanha push segmentada (todos, ou só telefones escolhidos) ──
  if (pathname === '/api/admin/send-push' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'enviar')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra enviar notificações.' });
    try {
      const { phones, title, message, url: targetUrl, image, sound } = await readBody(req);
      const { cfg } = readConfig();
      if (!cfg.vapid || !cfg.vapid.publicKey || !cfg.vapid.privateKeyJwk) return sendJSON(res, 400, { error: 'Chaves VAPID ainda não configuradas — reinicie o servidor.' });
      const msg = String(message || '').slice(0, 200).trim();
      const ttl = String(title || cfg.name || 'Shogatsu').slice(0, 80).trim();
      if (!msg) return sendJSON(res, 400, { error: 'Digite a mensagem.' });
      let subs = readJSON(PUSH_SUBS_FILE);
      const segment = Array.isArray(phones) && phones.length ? new Set(phones.map(normalizePhone)) : null;
      const targets = segment ? subs.filter(s => segment.has(s.phone)) : subs;
      if (!targets.length) return sendJSON(res, 400, { error: 'Nenhum inscrito encontrado pra esse envio.' });
      // v47 — BUG CORRIGIDO: o formulário de campanha (painel.html) já mandava "image" e
      // "sound" desde a v45, mas esse endpoint nunca lia esses campos do corpo da requisição —
      // então toda notificação saía sem banner e sem o sinal pra tocar o sino oriental,
      // mesmo quando o admin preenchia a imagem. Agora repassa os dois pro payload de verdade.
      const payload = { title: ttl, body: msg, url: targetUrl || '/', icon: '/icon-192.png', image: image || undefined, sound: sound || 'oriental', tag: 'shogatsu-campanha-' + Date.now() };
      const results = { sent: 0, failed: 0, errors: [] };
      const expiredEndpoints = [];
      for (const sub of targets) {
        const r = await webpush.sendWebPush(sub, payload, cfg.vapid, cfg.vapid.subject);
        if (r.ok) results.sent++;
        else { results.failed++; if (results.errors.length < 3) results.errors.push(`HTTP ${r.status || 0}`); if (r.expired) expiredEndpoints.push(sub.endpoint); }
      }
      if (expiredEndpoints.length) {
        subs = subs.filter(s => !expiredEndpoints.includes(s.endpoint));
        writeJSON(PUSH_SUBS_FILE, subs);
      }
      return sendJSON(res, 200, { ok: true, ...results, total: targets.length });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ═══════════════════════════════════════════
  // v79: PUSH DA LOJA (painel) — alerta de pedido/reserva novo simultâneo em PC + celular.
  // Reaproveita a mesma infraestrutura VAPID/webpush.js dos clientes, só que com uma lista de
  // inscrições separada (ADMIN_PUSH_SUBS_FILE): cada aparelho da loja que ativa vira 1 entrada,
  // e sendAdminPush() (definida lá em cima) manda pra todas elas ao mesmo tempo.
  // ═══════════════════════════════════════════
  // ── POST /api/admin/push/subscribe — este aparelho (painel) passa a receber alerta push ──
  if (pathname === '/api/admin/push/subscribe' && req.method === 'POST') {
    const session = getSession(getToken(req, query));
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { subscription, deviceLabel, silent } = await readBody(req);
      if (!subscription || !subscription.endpoint || !subscription.keys) return sendJSON(res, 400, { error: 'Inscrição inválida.' });
      const subs = readJSON(ADMIN_PUSH_SUBS_FILE);
      const existing = subs.findIndex(s => s.endpoint === subscription.endpoint);
      const entry = {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        deviceLabel: String(deviceLabel || '').slice(0, 60) || 'Aparelho sem nome',
        addedBy: session.username || '',
        // v81: preferência por aparelho — não manda o som do sistema (silent:true), porque
        // esse aparelho já toca o som configurado do painel enquanto está aberto. Se não vier
        // no corpo da requisição, mantém o que já estava salvo (evita resetar sozinho num
        // reenvio de rotina, ex: pushsubscriptionchange).
        silent: typeof silent === 'boolean' ? silent : (existing !== -1 ? !!subs[existing].silent : false),
        createdAt: existing === -1 ? new Date().toISOString() : subs[existing].createdAt,
        lastSeenAt: new Date().toISOString()
      };
      if (existing === -1) subs.push(entry); else subs[existing] = entry;
      writeJSON(ADMIN_PUSH_SUBS_FILE, subs);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/admin/push/unsubscribe ──
  if (pathname === '/api/admin/push/unsubscribe' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { endpoint } = await readBody(req);
      const subs = readJSON(ADMIN_PUSH_SUBS_FILE).filter(s => s.endpoint !== endpoint);
      writeJSON(ADMIN_PUSH_SUBS_FILE, subs);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── GET /api/admin/push/subs — lista os aparelhos da loja com alerta push ativado ──
  if (pathname === '/api/admin/push/subs' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'dispositivos', 'ver')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const subs = readJSON(ADMIN_PUSH_SUBS_FILE).map(s => ({ endpoint: s.endpoint, deviceLabel: s.deviceLabel, addedBy: s.addedBy, createdAt: s.createdAt, silent: !!s.silent }));
    return sendJSON(res, 200, { subs });
  }
  // ── POST /api/admin/push/test — manda uma notificação de teste pra todos os aparelhos ativados ──
  if (pathname === '/api/admin/push/test' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'dispositivos', 'gerenciar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const r = await sendAdminPush({ title: '🔔 Teste de alerta', body: 'Se você recebeu isso, o alerta push está funcionando neste aparelho!', url: '/painel.html', icon: '/icon-192.png', sound: 'oriental', tag: 'shogatsu-teste-push' });
    return sendJSON(res, 200, { ok: true, ...r });
  }

  // ═══════════════════════════════════════════
  // v79: NOTIFICAÇÕES PUSH AGENDADAS/RECORRENTES — campanha pros CLIENTES (mesma lista de
  // inscritos do "Enviar Notificação Push" de sempre), só que programada pra sair sozinha numa
  // data/hora escolhida, e opcionalmente se repetir (diária/semanal/mensal) sem precisar
  // reagendar toda vez. O disparo de verdade acontece em checkScheduledPush(), perto do fim
  // deste arquivo, que roda a cada 1 minuto.
  // ═══════════════════════════════════════════
  // ── GET /api/admin/scheduled-push — lista os agendamentos ──
  if (pathname === '/api/admin/scheduled-push' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'criar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    return sendJSON(res, 200, { items: readJSON(SCHEDULED_PUSH_FILE) });
  }
  // ── POST /api/admin/scheduled-push — cria um agendamento novo ──
  if (pathname === '/api/admin/scheduled-push' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'criar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const { title, message, image, url: targetUrl, phones, sendAll, sendAt, recurrence, intervalMinutes } = await readBody(req);
      const msg = String(message || '').slice(0, 200).trim();
      if (!msg) return sendJSON(res, 400, { error: 'Escreva a mensagem da notificação.' });
      const when = new Date(sendAt);
      if (isNaN(when.getTime())) return sendJSON(res, 400, { error: 'Escolha data e horário válidos.' });
      // v80: "hourly" = repetir VÁRIAS VEZES AO DIA (não só 1x/dia) — intervalMinutes define de
      // quanto em quanto tempo repete (ex: a cada 4h = 240). Antes só dava pra repetir 1x/dia
      // no mínimo (diária/semanal/mensal); agora dá pra reenviar várias vezes no mesmo dia.
      const rec = ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(recurrence) ? recurrence : 'none';
      const interval = rec === 'hourly' ? Math.max(5, Math.min(1440, Math.round(Number(intervalMinutes)) || 240)) : null;
      const list = readJSON(SCHEDULED_PUSH_FILE);
      const item = {
        id: 'AG' + Date.now().toString(36).toUpperCase(),
        title: String(title || '').slice(0, 80).trim(),
        message: msg,
        image: image ? String(image).slice(0, 500) : '',
        url: targetUrl ? String(targetUrl).slice(0, 200) : '/',
        phones: (!sendAll && Array.isArray(phones)) ? phones.map(normalizePhone) : null, // null = todos os inscritos
        sendAll: !!sendAll,
        recurrence: rec,
        intervalMinutes: interval,
        active: true,
        nextSendAt: when.toISOString(),
        lastSentAt: null,
        sentCount: 0,
        createdAt: new Date().toISOString(),
        createdBy: getSession(getToken(req, query))?.username || ''
      };
      list.push(item);
      writeJSON(SCHEDULED_PUSH_FILE, list);
      return sendJSON(res, 201, { ok: true, item });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── PUT /api/admin/scheduled-push/:id — edita ou pausa/reativa um agendamento ──
  if (pathname.match(/^\/api\/admin\/scheduled-push\/[^/]+$/) && req.method === 'PUT') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'editar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const id = decodeURIComponent(pathname.split('/').pop());
      const list = readJSON(SCHEDULED_PUSH_FILE);
      const item = list.find(i => i.id === id);
      if (!item) return sendJSON(res, 404, { error: 'Agendamento não encontrado.' });
      const body = await readBody(req);
      if (body.title !== undefined) item.title = String(body.title).slice(0, 80).trim();
      if (body.message !== undefined) item.message = String(body.message).slice(0, 200).trim();
      if (body.image !== undefined) item.image = String(body.image).slice(0, 500);
      if (body.url !== undefined) item.url = String(body.url).slice(0, 200);
      if (body.sendAll !== undefined) item.sendAll = !!body.sendAll;
      if (body.phones !== undefined) item.phones = (!item.sendAll && Array.isArray(body.phones)) ? body.phones.map(normalizePhone) : null;
      if (body.recurrence !== undefined && ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(body.recurrence)) item.recurrence = body.recurrence;
      if (body.intervalMinutes !== undefined) item.intervalMinutes = item.recurrence === 'hourly' ? Math.max(5, Math.min(1440, Math.round(Number(body.intervalMinutes)) || 240)) : null;
      if (body.sendAt !== undefined) {
        const when = new Date(body.sendAt);
        if (!isNaN(when.getTime())) item.nextSendAt = when.toISOString();
      }
      if (body.active !== undefined) item.active = !!body.active;
      writeJSON(SCHEDULED_PUSH_FILE, list);
      return sendJSON(res, 200, { ok: true, item });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── DELETE /api/admin/scheduled-push/:id ──
  if (pathname.match(/^\/api\/admin\/scheduled-push\/[^/]+$/) && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'notificacoes', 'editar')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const id = decodeURIComponent(pathname.split('/').pop());
    const list = readJSON(SCHEDULED_PUSH_FILE).filter(i => i.id !== id);
    writeJSON(SCHEDULED_PUSH_FILE, list);
    return sendJSON(res, 200, { ok: true });
  }

  // ═══════════════════════════════════════════
  // CUSTOS — cadastro de ingredientes e ficha técnica (v43: integrado no painel,
  // antes era o programa separado "shogatsu-custos")
  // ═══════════════════════════════════════════
  const CUSTOS_STATIONS = ['kg', 'g', 'l', 'ml', 'un'];
  const CUSTOS_FATOR = { kg: { kg: 1, g: 1000 }, g: { g: 1, kg: 0.001 }, l: { l: 1, ml: 1000 }, ml: { ml: 1, l: 0.001 }, un: { un: 1 } };
  function custosDefaultConfig() { return { diasParaDesatualizado: 21, margemPadrao: 65 }; }
  function custoDoItem(ingrediente, quantidade, unidadeUsada) {
    const un = ingrediente.unidade;
    const usada = unidadeUsada || un;
    if (un === usada) return ingrediente.precoUnitario * quantidade;
    const tabela = CUSTOS_FATOR[un];
    if (tabela && tabela[usada] !== undefined) return ingrediente.precoUnitario * (quantidade / tabela[usada]);
    return ingrediente.precoUnitario * quantidade;
  }
  // v91: resolve os itens de uma ficha — se ela for uma VARIAÇÃO (fichaBaseId setado, ex: "Hot
  // Filadélfia — 15 peças" apontando pra "Hot Filadélfia — base por peça"), busca os itens da
  // ficha base e multiplica cada quantidade pelo fator (`multiplicador`), em vez de guardar a
  // receita duplicada. Suporta encadeamento (variação de variação) com limite de profundidade
  // pra nunca travar num ciclo (ex: A aponta pra B que aponta pra A por engano).
  function resolverItensFicha(ficha, fichasPorId, depth) {
    depth = depth || 0;
    if (ficha.fichaBaseId && depth < 6) {
      const base = fichasPorId[ficha.fichaBaseId];
      if (base) {
        const itensBase = resolverItensFicha(base, fichasPorId, depth + 1);
        const mult = Number(ficha.multiplicador) || 1;
        return itensBase.map(it => ({ ...it, quantidade: (Number(it.quantidade) || 0) * mult }));
      }
    }
    return ficha.itens || [];
  }
  function calcularFichaTecnica(ficha, ingredientesPorId, custosCfg, fichasPorId) {
    let custoTotal = 0, temIngredienteFaltando = false, temPrecoDefasado = false;
    const limiteMs = (custosCfg.diasParaDesatualizado || 21) * 86400000;
    const agora = Date.now();
    const fichaBase = ficha.fichaBaseId && fichasPorId ? fichasPorId[ficha.fichaBaseId] : null;
    const itensResolvidos = fichasPorId ? resolverItensFicha(ficha, fichasPorId) : (ficha.itens || []);
    const itensCalculados = (itensResolvidos || []).map(item => {
      const ing = ingredientesPorId[item.ingredienteId];
      if (!ing) { temIngredienteFaltando = true; return { ...item, custo: 0, erro: 'ingrediente não encontrado' }; }
      const custo = custoDoItem(ing, Number(item.quantidade) || 0, item.unidade);
      custoTotal += custo;
      const desatualizado = agora - new Date(ing.atualizadoEm).getTime() > limiteMs;
      if (desatualizado) temPrecoDefasado = true;
      return { ...item, nomeIngrediente: ing.nome, unidadeIngrediente: ing.unidade, precoUnitarioIngrediente: ing.precoUnitario, custo: Math.round(custo * 100) / 100, desatualizado };
    });
    const rendimento = Number(ficha.rendimento) || 1;
    const custoPorPorcao = custoTotal / rendimento;
    const margem = (ficha.margemDesejada !== undefined && ficha.margemDesejada !== null && ficha.margemDesejada !== '') ? Number(ficha.margemDesejada) : (custosCfg.margemPadrao || 65);
    const margemFrac = Math.min(Math.max(margem, 0), 95) / 100;
    const precoSugerido = margemFrac < 1 ? custoPorPorcao / (1 - margemFrac) : custoPorPorcao;
    let cmv = null;
    if (ficha.precoVendaAtual && Number(ficha.precoVendaAtual) > 0) cmv = (custoPorPorcao / Number(ficha.precoVendaAtual)) * 100;
    return {
      ...ficha, itensCalculados,
      custoTotal: Math.round(custoTotal * 100) / 100,
      custoPorPorcao: Math.round(custoPorPorcao * 100) / 100,
      precoSugerido: Math.round(precoSugerido * 100) / 100,
      cmvPercentual: cmv !== null ? Math.round(cmv * 10) / 10 : null,
      temIngredienteFaltando, temPrecoDefasado,
      status: ficha.status || 'oficial',
      origem: ficha.origem || 'Cadastro manual',
      nomeFichaBase: fichaBase ? fichaBase.nome : null
    };
  }
  // Monta o índice { id: ficha } usado pra resolver variações (fichaBaseId) — sempre a partir da
  // lista COMPLETA e crua (sem cálculo), pra nunca resolver contra uma versão já derivada.
  function fichasIndexadasPorId(fichas) { return Object.fromEntries(fichas.map(f => [f.id, f])); }

  // ── GET /api/custos/ingredientes ──
  if (pathname === '/api/custos/ingredientes' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const lista = readJSON(INGREDIENTES_FILE, []);
    const cfg = readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig());
    const limiteMs = (cfg.diasParaDesatualizado || 21) * 86400000;
    const agora = Date.now();
    return sendJSON(res, 200, lista.map(i => ({ ...i, desatualizado: agora - new Date(i.atualizadoEm).getTime() > limiteMs })));
  }
  // ── POST /api/custos/ingredientes ──
  if (pathname === '/api/custos/ingredientes' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      if (!body.nome || !body.unidade || body.precoUnitario === undefined) return sendJSON(res, 400, { error: 'nome, unidade e precoUnitario são obrigatórios' });
      if (!CUSTOS_STATIONS.includes(body.unidade)) return sendJSON(res, 400, { error: 'Unidade inválida.' });
      const lista = readJSON(INGREDIENTES_FILE, []);
      const novo = {
        id: crypto.randomBytes(8).toString('hex'),
        nome: String(body.nome).trim().slice(0, 120),
        categoria: body.categoria ? String(body.categoria).trim().slice(0, 60) : 'Geral',
        unidade: body.unidade,
        precoUnitario: Number(body.precoUnitario) || 0,
        atualizadoEm: new Date().toISOString(),
        referenciaWeb: false,
        fornecedor: body.fornecedor ? String(body.fornecedor).trim().slice(0, 120) : '',
      };
      lista.push(novo);
      writeJSON(INGREDIENTES_FILE, lista);
      return sendJSON(res, 201, novo);
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  const custosIngMatch = pathname.match(/^\/api\/custos\/ingredientes\/([^/]+)$/);
  if (custosIngMatch && req.method === 'PUT') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const id = custosIngMatch[1];
      const body = await readBody(req);
      const lista = readJSON(INGREDIENTES_FILE, []);
      const idx = lista.findIndex(i => i.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Ingrediente não encontrado.' });
      const antigo = lista[idx];
      const precoMudou = body.precoUnitario !== undefined && Number(body.precoUnitario) !== antigo.precoUnitario;
      lista[idx] = {
        ...antigo, ...body,
        precoUnitario: body.precoUnitario !== undefined ? Number(body.precoUnitario) : antigo.precoUnitario,
        atualizadoEm: precoMudou ? new Date().toISOString() : antigo.atualizadoEm,
        referenciaWeb: precoMudou ? false : antigo.referenciaWeb,
      };
      writeJSON(INGREDIENTES_FILE, lista);
      return sendJSON(res, 200, lista[idx]);
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── DELETE /api/custos/ingredientes/:id ──
  if (custosIngMatch && req.method === 'DELETE') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = custosIngMatch[1];
    let lista = readJSON(INGREDIENTES_FILE, []);
    const antes = lista.length;
    lista = lista.filter(i => i.id !== id);
    writeJSON(INGREDIENTES_FILE, lista);
    return sendJSON(res, 200, { removido: antes !== lista.length });
  }

  // ── GET /api/custos/fichas ──
  if (pathname === '/api/custos/fichas' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
    const ingredientes = readJSON(INGREDIENTES_FILE, []);
    const cfg = readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig());
    const porId = Object.fromEntries(ingredientes.map(i => [i.id, i]));
    const fichasPorId = fichasIndexadasPorId(fichas);
    return sendJSON(res, 200, fichas.map(f => calcularFichaTecnica(f, porId, cfg, fichasPorId)));
  }
  // ── POST /api/custos/fichas ──
  if (pathname === '/api/custos/fichas' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      if (!body.nome) return sendJSON(res, 400, { error: 'nome é obrigatório' });
      const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
      const STATUS_VALIDOS = ['oficial', 'estimada', 'revisao'];
      const fichaBaseId = body.fichaBaseId && fichas.some(f => f.id === body.fichaBaseId) ? body.fichaBaseId : null;
      const nova = {
        id: crypto.randomBytes(8).toString('hex'),
        nome: String(body.nome).trim().slice(0, 120),
        categoria: body.categoria ? String(body.categoria).trim().slice(0, 60) : '',
        rendimento: Number(body.rendimento) || 1,
        margemDesejada: body.margemDesejada ?? null,
        precoVendaAtual: body.precoVendaAtual ?? null,
        // v91: se for uma variação (fichaBaseId setado), a receita vem da base × multiplicador —
        // itens próprios ficam vazios de propósito, pra nunca duplicar a receita.
        itens: fichaBaseId ? [] : (Array.isArray(body.itens) ? body.itens : []),
        fichaBaseId,
        multiplicador: fichaBaseId ? (Number(body.multiplicador) || 1) : null,
        status: STATUS_VALIDOS.includes(body.status) ? body.status : 'oficial',
        origem: body.origem ? String(body.origem).trim().slice(0, 200) : 'Cadastro manual',
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      };
      fichas.push(nova);
      writeJSON(FICHAS_TECNICAS_FILE, fichas);
      const ingredientes = readJSON(INGREDIENTES_FILE, []);
      const cfg = readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig());
      return sendJSON(res, 201, calcularFichaTecnica(nova, Object.fromEntries(ingredientes.map(i => [i.id, i])), cfg, fichasIndexadasPorId(fichas)));
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/custos/fichas/:id/confirmar — marca a ficha como 🟢 OFICIAL (v91). Não altera a
  // receita, só o status + registra quando/por quem foi confirmada. ──
  const custosFichaConfirmarMatch = pathname.match(/^\/api\/custos\/fichas\/([^/]+)\/confirmar$/);
  if (custosFichaConfirmarMatch && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = custosFichaConfirmarMatch[1];
    const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
    const idx = fichas.findIndex(f => f.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Ficha não encontrada.' });
    const quem = getSession(getToken(req, query))?.username || '';
    fichas[idx].status = 'oficial';
    fichas[idx].origem = `Confirmada como oficial${quem ? ' por ' + quem : ''} em ${new Date().toLocaleDateString('pt-BR')}`;
    fichas[idx].atualizadoEm = new Date().toISOString();
    writeJSON(FICHAS_TECNICAS_FILE, fichas);
    const ingredientes = readJSON(INGREDIENTES_FILE, []);
    const cfg = readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig());
    return sendJSON(res, 200, calcularFichaTecnica(fichas[idx], Object.fromEntries(ingredientes.map(i => [i.id, i])), cfg, fichasIndexadasPorId(fichas)));
  }
  // ── PUT /api/custos/fichas/:id ──
  const custosFichaMatch = pathname.match(/^\/api\/custos\/fichas\/([^/]+)$/);
  if (custosFichaMatch && req.method === 'PUT') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const id = custosFichaMatch[1];
      const body = await readBody(req);
      const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
      const idx = fichas.findIndex(f => f.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Ficha não encontrada.' });
      const STATUS_VALIDOS = ['oficial', 'estimada', 'revisao'];
      const atual = fichas[idx];
      // v91: se estiver vinculando/trocando a ficha base, valida que existe e que não cria um
      // ciclo (uma ficha não pode ser base de si mesma, direta ou indiretamente).
      let fichaBaseId = atual.fichaBaseId;
      if (body.fichaBaseId !== undefined) {
        if (body.fichaBaseId === null || body.fichaBaseId === '') {
          fichaBaseId = null;
        } else if (body.fichaBaseId === id) {
          return sendJSON(res, 400, { error: 'Uma ficha não pode ser base dela mesma.' });
        } else {
          let cursor = fichas.find(f => f.id === body.fichaBaseId);
          if (!cursor) return sendJSON(res, 400, { error: 'Ficha base não encontrada.' });
          let hops = 0;
          while (cursor && cursor.fichaBaseId && hops < 10) {
            if (cursor.fichaBaseId === id) return sendJSON(res, 400, { error: 'Isso criaria um ciclo entre fichas.' });
            cursor = fichas.find(f => f.id === cursor.fichaBaseId);
            hops++;
          }
          fichaBaseId = body.fichaBaseId;
        }
      }
      const precoMudou = body.precoVendaAtual !== undefined && body.precoVendaAtual !== atual.precoVendaAtual;
      const itensMudaram = body.itens !== undefined && JSON.stringify(body.itens) !== JSON.stringify(atual.itens);
      fichas[idx] = {
        ...atual, ...body, id,
        fichaBaseId,
        multiplicador: fichaBaseId ? (body.multiplicador !== undefined ? (Number(body.multiplicador) || 1) : (atual.multiplicador || 1)) : null,
        itens: fichaBaseId ? [] : (body.itens !== undefined ? body.itens : atual.itens),
        status: STATUS_VALIDOS.includes(body.status) ? body.status : atual.status,
        atualizadoEm: (itensMudaram || precoMudou || body.status !== undefined || body.fichaBaseId !== undefined) ? new Date().toISOString() : (atual.atualizadoEm || new Date().toISOString()),
      };
      writeJSON(FICHAS_TECNICAS_FILE, fichas);
      const ingredientes = readJSON(INGREDIENTES_FILE, []);
      const cfg = readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig());
      return sendJSON(res, 200, calcularFichaTecnica(fichas[idx], Object.fromEntries(ingredientes.map(i => [i.id, i])), cfg, fichasIndexadasPorId(fichas)));
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── DELETE /api/custos/fichas/:id ──
  if (custosFichaMatch && req.method === 'DELETE') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = custosFichaMatch[1];
    let fichas = readJSON(FICHAS_TECNICAS_FILE, []);
    // v91: se outras fichas usam esta como base (ex: "10 peças"/"15 peças" apontando pra "base por
    // peça"), avisa em vez de apagar e deixar as variações órfãs sem receita — a menos que o admin
    // confirme explicitamente com ?force=1.
    const dependentes = fichas.filter(f => f.fichaBaseId === id);
    if (dependentes.length && query.force !== '1') {
      return sendJSON(res, 409, { error: `Essa ficha é a base de ${dependentes.length} variação(ões): ${dependentes.map(f => f.nome).join(', ')}. Exclua ou desvincule elas primeiro, ou confirme com force=1.` });
    }
    const antes = fichas.length;
    fichas = fichas.filter(f => f.id !== id);
    writeJSON(FICHAS_TECNICAS_FILE, fichas);
    return sendJSON(res, 200, { removido: antes !== fichas.length });
  }

  // ── GET/PUT /api/custos/config ──
  if (pathname === '/api/custos/config' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig()));
  }
  if (pathname === '/api/custos/config' && req.method === 'PUT') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const novo = { ...readJSON(CUSTOS_CONFIG_FILE, custosDefaultConfig()), ...body };
      writeJSON(CUSTOS_CONFIG_FILE, novo);
      return sendJSON(res, 200, novo);
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/custos/importar-cardapio — cria 1 ficha em branco por prato do cardápio atual ──
  if (pathname === '/api/custos/importar-cardapio' && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const { cfg, menu } = readConfig();
      const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
      const existentes = new Set(fichas.map(f => f.nome));
      let criadas = 0;
      for (const categoria of menu || []) {
        for (const item of categoria.items || []) {
          if (existentes.has(item.name)) continue;
          fichas.push({ id: crypto.randomBytes(8).toString('hex'), nome: item.name, categoria: categoria.title, rendimento: 1, margemDesejada: null, precoVendaAtual: item.price, itens: [], fichaBaseId: null, multiplicador: null, status: 'revisao', origem: 'Importada do cardápio (sem ingredientes ainda)', criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
          existentes.add(item.name);
          criadas++;
        }
      }
      writeJSON(FICHAS_TECNICAS_FILE, fichas);
      return sendJSON(res, 200, { ok: true, criadas });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ═══════════════════════════════════════════
  // IA DE GESTÃO — CENTRAL DE APROVAÇÕES (v91)
  // Nada nesta seção altera o cardápio público, preço, ficha oficial ou qualquer outra coisa
  // sozinho. A IA só CRIA PROPOSTAS (status "pendente") aqui; um admin precisa aprovar
  // explicitamente em /api/ia/aprovacoes/:id/aprovar pra algo virar realidade no sistema.
  // ═══════════════════════════════════════════
  const APROVACAO_TIPOS = ['novo_produto', 'alteracao', 'preco', 'ficha', 'badge'];

  // ── POST /api/ia/fichas/gerar-faltantes — v93: varre o cardápio JÁ EXISTENTE e, pros pratos
  // que ainda não têm ficha técnica cadastrada, pede uma estimativa pra IA e registra como
  // proposta PENDENTE (tipo "ficha") — não cria nada na planilha de custo sozinho. Limita a
  // poucos itens por chamada (a IA de texto é lenta pra fazer isso em massa de uma vez). ──
  if (pathname === '/api/ia/fichas/gerar-faltantes' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const body = await readBody(req).catch(() => ({}));
      const limite = Math.max(1, Math.min(8, Number(body.limite) || 5));
      const { cfg, menu } = readConfig();
      if (!cfg.ia || !cfg.ia.enabled || !cfg.ia.apiKey) return sendJSON(res, 400, { error: 'Configure a IA de Atendimento em Configurações antes de gerar fichas (é a mesma IA usada aqui).' });
      const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
      const ingredientes = readJSON(INGREDIENTES_FILE, []);
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const nomesComFicha = new Set(fichas.map(f => norm(f.nome)));
      const aprovacoesExistentes = readJSON(APROVACOES_IA_FILE, []);
      const nomesJaPendentes = new Set(aprovacoesExistentes.filter(a => a.tipo === 'ficha' && a.status === 'pendente').map(a => norm(a.dados && a.dados.itemNome)));

      const faltando = [];
      (menu || []).forEach(cat => (cat.items || []).forEach(it => {
        const n = norm(it.name);
        if (!nomesComFicha.has(n) && !nomesJaPendentes.has(n)) faltando.push({ item: it, categoria: cat.title });
      }));

      if (!faltando.length) return sendJSON(res, 200, { totalFaltando: 0, geradas: 0, propostas: [], mensagem: 'Todo o cardápio já tem ficha técnica (oficial, estimada, ou já pendente de aprovação).' });

      const lote = faltando.slice(0, limite);
      const aprovacoes = readJSON(APROVACOES_IA_FILE, []);
      const criadas = [];
      for (const { item, categoria } of lote) {
        try {
          const est = await estimarFichaParaProdutoExistente(cfg.ia, item, categoria, ingredientes);
          const norm2 = norm;
          const itensFicha = est.ingredientes.map(ing => {
            const existente = ingredientes.find(i => norm2(i.nome) === norm2(ing.nome));
            return {
              ingredienteId: existente ? existente.id : null,
              nomeNovoIngrediente: existente ? null : String(ing.nome || '').slice(0, 120),
              quantidade: Number(ing.quantidade) || 0,
              unidade: ['g', 'kg', 'ml', 'l', 'un'].includes(ing.unidade) ? ing.unidade : 'g',
            };
          });
          const proposta = {
            id: crypto.randomBytes(8).toString('hex'),
            tipo: 'ficha',
            status: 'pendente',
            titulo: `Ficha técnica: ${item.name}`,
            dados: {
              itemNome: item.name, categoria, rendimento: Number(est.rendimento) || 1,
              itensFicha, custoEstimado: Number(est.custoEstimado) || 0, precoVendaAtual: item.price,
            },
            justificativa: String(est.observacao || '').slice(0, 500),
            fontes: [],
            origem: 'Estimativa da IA pra um prato que já existe no cardápio, sem ficha técnica cadastrada — sem pesquisa real na internet.',
            criadoEm: new Date().toISOString(),
            decididoEm: null, decididoPor: null, motivoRejeicao: null,
          };
          aprovacoes.unshift(proposta);
          criadas.push(proposta);
        } catch (e) { /* esse item específico falhou (resposta inválida da IA) — pula e tenta os outros do lote */ }
      }
      writeJSON(APROVACOES_IA_FILE, aprovacoes);
      return sendJSON(res, 200, { totalFaltando: faltando.length, geradas: criadas.length, restam: faltando.length - lote.length, propostas: criadas });
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Não consegui gerar as fichas agora.' }); }
  }

  // ── POST /api/ia/produtos/sugerir — pede pra IA imaginar um prato novo e registra como
  // proposta PENDENTE (não mexe no cardápio). body.tema é opcional (ex: "algo com atum"). ──
  if (pathname === '/api/ia/produtos/sugerir' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'criarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const body = await readBody(req).catch(() => ({}));
      const { cfg, menu } = readConfig();
      if (!cfg.ia || !cfg.ia.enabled || !cfg.ia.apiKey) return sendJSON(res, 400, { error: 'Configure a IA de Atendimento em Configurações antes de pedir sugestões (é a mesma IA usada aqui).' });
      const ingredientes = readJSON(INGREDIENTES_FILE, []);
      const sugestao = await sugerirNovoProdutoIA(cfg.ia, cfg, menu, ingredientes, (body.tema || '').slice(0, 200));
      // Casa cada ingrediente sugerido com um já cadastrado pelo nome (ignorando maiúscula/acento);
      // o que não bater fica marcado como "novo" — só é criado de fato se o admin aprovar.
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const itensFicha = (Array.isArray(sugestao.ingredientes) ? sugestao.ingredientes : []).map(ing => {
        const existente = ingredientes.find(i => norm(i.nome) === norm(ing.nome));
        return {
          ingredienteId: existente ? existente.id : null,
          nomeNovoIngrediente: existente ? null : String(ing.nome || '').slice(0, 120),
          quantidade: Number(ing.quantidade) || 0,
          unidade: ['g', 'kg', 'ml', 'l', 'un'].includes(ing.unidade) ? ing.unidade : 'g',
        };
      });
      const aprovacoes = readJSON(APROVACOES_IA_FILE, []);
      const proposta = {
        id: crypto.randomBytes(8).toString('hex'),
        tipo: 'novo_produto',
        status: 'pendente',
        titulo: sugestao.nome,
        dados: {
          nome: String(sugestao.nome).slice(0, 120),
          categoria: String(sugestao.categoria || 'Sugestões da IA').slice(0, 60),
          descricao: String(sugestao.descricao || '').slice(0, 400),
          rendimento: Number(sugestao.rendimento) || 1,
          badgeSugerido: String(sugestao.badgeSugerido || '').slice(0, 40),
          itensFicha,
          custoEstimado: Number(sugestao.custoEstimado) || 0,
          precoSugerido: Number(sugestao.precoSugerido) || 0,
          margemEstimadaPercentual: Number(sugestao.margemEstimadaPercentual) || null,
        },
        justificativa: String(sugestao.justificativa || '').slice(0, 600),
        fontes: [], // v91: sem pesquisa real na internet ainda — ver observação em sugerirNovoProdutoIA
        origem: 'Sugestão da IA (sem pesquisa real na internet — estimativa do modelo)',
        criadoEm: new Date().toISOString(),
        decididoEm: null,
        decididoPor: null,
        motivoRejeicao: null,
      };
      aprovacoes.unshift(proposta);
      writeJSON(APROVACOES_IA_FILE, aprovacoes);
      return sendJSON(res, 201, proposta);
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Não consegui gerar uma sugestão agora.' }); }
  }

  // ── POST /api/ia/badges/sugerir — analisa vendas reais (data/orders.json) dos últimos N dias
  // e sugere 🔥 "Mais Pedido" pros itens mais vendidos que ainda não têm esse badge. Não usa a IA
  // de texto pra isso (é estatística direta sobre pedidos de verdade, não estimativa). Se
  // cfg.ia.badgesAutoAprovar estiver ligado, a sugestão já entra como aprovada (aplicada na
  // hora); senão fica pendente igual as outras propostas. ──
  if (pathname === '/api/ia/badges/sugerir' && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const body = await readBody(req).catch(() => ({}));
      const janelaDias = Math.max(1, Number(body.dias) || 30);
      const topN = Math.max(1, Math.min(10, Number(body.topN) || 3));
      const { cfg, menu } = readConfig();
      const orders = readJSON(ORDERS_FILE);
      const desde = Date.now() - janelaDias * 86400000;
      const vendasPorNome = {};
      orders.filter(o => o.status !== 'cancelado' && new Date(o.createdAt).getTime() >= desde)
        .forEach(o => (o.items || []).forEach(i => { vendasPorNome[i.name] = (vendasPorNome[i.name] || 0) + (Number(i.qty) || 0); }));

      const todosItens = [];
      (menu || []).forEach(cat => (cat.items || []).forEach(it => todosItens.push({ item: it, categoria: cat.title })));
      const ranking = todosItens
        .map(({ item, categoria }) => ({ item, categoria, vendas: vendasPorNome[item.name] || 0 }))
        .filter(r => r.vendas > 0)
        .sort((a, b) => b.vendas - a.vendas)
        .slice(0, topN);

      const aprovacoes = readJSON(APROVACOES_IA_FILE, []);
      const quem = getSession(getToken(req, query))?.username || '';
      const autoAprovar = !!cfg.ia.badgesAutoAprovar;
      const criadas = [];
      const BADGE_SUGERIDO = '🔥 Mais Pedido';
      for (const r of ranking) {
        if (r.item.badgeOverride === BADGE_SUGERIDO) continue; // já tem esse badge, nada a sugerir
        const proposta = {
          id: crypto.randomBytes(8).toString('hex'),
          tipo: 'badge',
          status: 'pendente',
          titulo: `Badge para ${r.item.name}`,
          dados: { itemId: r.item.id, categoria: r.categoria, nomeItem: r.item.name, badgeAtual: r.item.badgeOverride || '', badgeSugerido: BADGE_SUGERIDO },
          justificativa: `${r.item.name} vendeu ${r.vendas} unidade(s) nos últimos ${janelaDias} dias — um dos mais pedidos do cardápio no período.`,
          fontes: ['data/orders.json (vendas reais do próprio sistema)'],
          origem: `Sugestão baseada em vendas reais dos últimos ${janelaDias} dias`,
          criadoEm: new Date().toISOString(),
          decididoEm: null, decididoPor: null, motivoRejeicao: null,
        };
        if (autoAprovar) {
          // aplica direto no cardápio
          const catObj = menu.find(c => c.title === r.categoria);
          const itObj = catObj && catObj.items.find(i => i.id === r.item.id);
          if (itObj) { itObj.badgeMode = 'custom'; itObj.badgeOverride = BADGE_SUGERIDO; }
          proposta.status = 'aprovado';
          proposta.decididoEm = new Date().toISOString();
          proposta.decididoPor = quem;
          proposta.origem += ' — auto-aprovado (Configurações → IA → "Permitir alteração automática de badges" está ligado)';
        }
        aprovacoes.unshift(proposta);
        criadas.push(proposta);
      }
      if (autoAprovar && criadas.length) writeJSON(CONFIG_FILE, { cfg, menu });
      writeJSON(APROVACOES_IA_FILE, aprovacoes);
      return sendJSON(res, 200, { criadas: criadas.length, autoAprovadas: autoAprovar, propostas: criadas });
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Não consegui analisar as vendas agora.' }); }
  }

  // ── GET /api/ia/aprovacoes?status=pendente&tipo=novo_produto ──
  if (pathname === '/api/ia/aprovacoes' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    let lista = readJSON(APROVACOES_IA_FILE, []);
    if (query.status) lista = lista.filter(a => a.status === query.status);
    if (query.tipo) lista = lista.filter(a => a.tipo === query.tipo);
    return sendJSON(res, 200, lista);
  }

  // ── POST /api/ia/aprovacoes/:id/aprovar — body opcional pode sobrescrever campos de "dados"
  // antes de aplicar (ex: admin ajusta o preço sugerido) e { publicar:false } pra salvar como
  // rascunho no cardápio (item criado com available:false) em vez de publicar liberado. ──
  const aprovarMatch = pathname.match(/^\/api\/ia\/aprovacoes\/([^/]+)\/aprovar$/);
  if (aprovarMatch && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const id = aprovarMatch[1];
      const body = await readBody(req).catch(() => ({}));
      const aprovacoes = readJSON(APROVACOES_IA_FILE, []);
      const idx = aprovacoes.findIndex(a => a.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Proposta não encontrada.' });
      const proposta = aprovacoes[idx];
      if (proposta.status !== 'pendente') return sendJSON(res, 400, { error: 'Essa proposta já foi decidida.' });
      const quem = getSession(getToken(req, query))?.username || '';
      const publicar = body.publicar !== false; // padrão: aprovar já publica (seção 13 do escopo)

      if (proposta.tipo === 'novo_produto') {
        const dados = { ...proposta.dados, ...(body.dados || {}) };
        // 1) cria no cadastro de ingredientes qualquer item que a IA sugeriu e ainda não existia —
        //    entra com referenciaWeb:true (preço é estimativa, não confirmado pelo admin ainda).
        const ingredientes = readJSON(INGREDIENTES_FILE, []);
        const itensFichaResolvidos = (dados.itensFicha || []).map(item => {
          if (item.ingredienteId) return { ingredienteId: item.ingredienteId, quantidade: item.quantidade, unidade: item.unidade };
          const novoIng = {
            id: crypto.randomBytes(8).toString('hex'),
            nome: item.nomeNovoIngrediente || 'Ingrediente sugerido pela IA',
            categoria: 'Geral',
            unidade: item.unidade || 'g',
            precoUnitario: 0,
            atualizadoEm: new Date().toISOString(),
            referenciaWeb: true,
            fornecedor: '',
          };
          ingredientes.push(novoIng);
          return { ingredienteId: novoIng.id, quantidade: item.quantidade, unidade: item.unidade };
        });
        writeJSON(INGREDIENTES_FILE, ingredientes);

        // 2) cria a ficha técnica como ESTIMADA (a receita em si continua precisando de
        //    confirmação separada em Custos → Fichas Técnicas, mesmo depois do produto aprovado).
        const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
        const novaFicha = {
          id: crypto.randomBytes(8).toString('hex'),
          nome: dados.nome, categoria: dados.categoria, rendimento: dados.rendimento || 1,
          margemDesejada: dados.margemEstimadaPercentual || null,
          precoVendaAtual: dados.precoSugerido || null,
          itens: itensFichaResolvidos, fichaBaseId: null, multiplicador: null,
          status: 'estimada',
          origem: `Gerada a partir de sugestão da IA, aprovada${quem ? ' por ' + quem : ''} em ${new Date().toLocaleDateString('pt-BR')} — receita ainda precisa ser conferida na cozinha antes de virar oficial.`,
          criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
        };
        fichas.push(novaFicha);
        writeJSON(FICHAS_TECNICAS_FILE, fichas);

        // 3) cria o item no cardápio (menu). Se a categoria não existir ainda, cria uma nova.
        const { cfg, menu } = readConfig();
        let categoria = menu.find(c => (c.title || '').trim().toLowerCase() === (dados.categoria || '').trim().toLowerCase());
        if (!categoria) { categoria = { title: dados.categoria || 'Sugestões da IA', items: [], stations: [] }; menu.push(categoria); }
        const novoItem = {
          id: crypto.randomBytes(8).toString('hex'),
          name: dados.nome,
          description: dados.descricao || '',
          price: Number(dados.precoSugerido) || 0,
          available: publicar,
          variants: [],
          badgeMode: dados.badgeSugerido ? 'custom' : 'none',
          badgeOverride: dados.badgeSugerido || '',
          origemIA: true,
        };
        categoria.items.push(novoItem);
        writeJSON(CONFIG_FILE, { cfg, menu });

        proposta.dados = dados;
        proposta.resultado = { itemId: novoItem.id, fichaId: novaFicha.id, publicado: publicar };
      }
      if (proposta.tipo === 'badge') {
        const dados = { ...proposta.dados, ...(body.dados || {}) };
        const { cfg, menu } = readConfig();
        const catObj = menu.find(c => c.title === dados.categoria);
        const itObj = catObj && catObj.items.find(i => i.id === dados.itemId);
        if (!itObj) return sendJSON(res, 404, { error: 'O item do cardápio dessa sugestão não existe mais.' });
        itObj.badgeMode = 'custom';
        itObj.badgeOverride = dados.badgeSugerido || '';
        writeJSON(CONFIG_FILE, { cfg, menu });
        proposta.dados = dados;
        proposta.resultado = { itemId: itObj.id, badgeAplicado: itObj.badgeOverride };
      }
      if (proposta.tipo === 'ficha') {
        const dados = { ...proposta.dados, ...(body.dados || {}) };
        const ingredientes = readJSON(INGREDIENTES_FILE, []);
        const itensFichaResolvidos = (dados.itensFicha || []).map(item => {
          if (item.ingredienteId) return { ingredienteId: item.ingredienteId, quantidade: item.quantidade, unidade: item.unidade };
          const novoIng = {
            id: crypto.randomBytes(8).toString('hex'), nome: item.nomeNovoIngrediente || 'Ingrediente sugerido pela IA',
            categoria: 'Geral', unidade: item.unidade || 'g', precoUnitario: 0,
            atualizadoEm: new Date().toISOString(), referenciaWeb: true, fornecedor: '',
          };
          ingredientes.push(novoIng);
          return { ingredienteId: novoIng.id, quantidade: item.quantidade, unidade: item.unidade };
        });
        writeJSON(INGREDIENTES_FILE, ingredientes);
        const fichas = readJSON(FICHAS_TECNICAS_FILE, []);
        const novaFicha = {
          id: crypto.randomBytes(8).toString('hex'),
          nome: dados.itemNome, categoria: dados.categoria, rendimento: dados.rendimento || 1,
          margemDesejada: null, precoVendaAtual: dados.precoVendaAtual || null,
          itens: itensFichaResolvidos, fichaBaseId: null, multiplicador: null,
          status: 'estimada',
          origem: `Gerada pela IA pra um prato que já existia no cardápio, aprovada${quem ? ' por ' + quem : ''} em ${new Date().toLocaleDateString('pt-BR')} — ainda precisa ser conferida na cozinha antes de virar oficial.`,
          criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
        };
        fichas.push(novaFicha);
        writeJSON(FICHAS_TECNICAS_FILE, fichas);
        proposta.dados = dados;
        proposta.resultado = { fichaId: novaFicha.id };
      }
      // tipos futuros (alteracao/preco) — aplicados quando essas fases forem construídas;
      // por enquanto, aprovar só muda o status (sem efeito automático no sistema).

      proposta.status = 'aprovado';
      proposta.decididoEm = new Date().toISOString();
      proposta.decididoPor = quem;
      writeJSON(APROVACOES_IA_FILE, aprovacoes);
      return sendJSON(res, 200, proposta);
    } catch (e) { return sendJSON(res, 400, { error: e.message || 'Erro ao aprovar.' }); }
  }

  // ── POST /api/ia/aprovacoes/:id/rejeitar — body: { motivo } (opcional) ──
  const rejeitarMatch = pathname.match(/^\/api\/ia\/aprovacoes\/([^/]+)\/rejeitar$/);
  if (rejeitarMatch && req.method === 'POST') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    try {
      const id = rejeitarMatch[1];
      const body = await readBody(req).catch(() => ({}));
      const aprovacoes = readJSON(APROVACOES_IA_FILE, []);
      const idx = aprovacoes.findIndex(a => a.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Proposta não encontrada.' });
      if (aprovacoes[idx].status !== 'pendente') return sendJSON(res, 400, { error: 'Essa proposta já foi decidida.' });
      const quem = getSession(getToken(req, query))?.username || '';
      aprovacoes[idx].status = 'rejeitado';
      aprovacoes[idx].decididoEm = new Date().toISOString();
      aprovacoes[idx].decididoPor = quem;
      aprovacoes[idx].motivoRejeicao = String(body.motivo || '').slice(0, 300);
      writeJSON(APROVACOES_IA_FILE, aprovacoes);
      return sendJSON(res, 200, aprovacoes[idx]);
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── DELETE /api/ia/aprovacoes/:id — remove do histórico (limpeza manual; só itens já decididos) ──
  const aprovacaoDelMatch = pathname.match(/^\/api\/ia\/aprovacoes\/([^/]+)$/);
  if (aprovacaoDelMatch && req.method === 'DELETE') {
    if (!requirePermission(getToken(req, query), 'cardapio', 'editarProduto')) return sendJSON(res, 403, { error: 'Sem permissão.' });
    const id = aprovacaoDelMatch[1];
    let aprovacoes = readJSON(APROVACOES_IA_FILE, []);
    const alvo = aprovacoes.find(a => a.id === id);
    if (alvo && alvo.status === 'pendente') return sendJSON(res, 400, { error: 'Aprove ou rejeite antes de remover do histórico.' });
    aprovacoes = aprovacoes.filter(a => a.id !== id);
    writeJSON(APROVACOES_IA_FILE, aprovacoes);
    return sendJSON(res, 200, { ok: true });
  }

  // ═══════════════════════════════════════════
  // RESERVA DE MESAS
  // ═══════════════════════════════════════════
  // v126 — NOVO ("botão pra definir que dia/horário está liberado pra reservar"): valida de
  // verdade, no SERVIDOR, se a data/horário pedidos pra reserva estão dentro do horário
  // liberado — antes só o navegador do cliente filtrava visualmente os horários (só mostrava
  // botões dentro do expediente), mas nada impedia uma chamada direta à API com qualquer
  // data/horário (inclusive um dia fechado ou 3h da manhã). Usa cfg.reservations.schedule
  // (ou cfg.weekSchedule, se "usar mesmo horário da loja" estiver ligado) + a lista de datas
  // bloqueadas (feriado, evento fechado etc.).
  function isReservationSlotAvailable(cfg, dateStr, timeStr) {
    if (!dateStr || !timeStr) return { ok: false, error: 'Escolha data e horário.' };
    if (cfg.reservations.blockedDates && cfg.reservations.blockedDates.includes(dateStr)) {
      return { ok: false, error: 'Essa data não está disponível pra reserva.' };
    }
    const effectiveSchedule = cfg.reservations.useStoreSchedule ? cfg.weekSchedule : cfg.reservations.schedule;
    const weekday = new Date(dateStr + 'T00:00:00').getDay();
    const daySchedule = effectiveSchedule && effectiveSchedule[weekday];
    if (!daySchedule || daySchedule.open === false) {
      return { ok: false, error: 'A loja não aceita reserva nesse dia da semana.' };
    }
    const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const t = toMin(timeStr);
    const openM = toMin(daySchedule.openTime || '18:00'), closeM = toMin(daySchedule.closeTime || '23:00');
    if (t < openM || t > closeM - 30) {
      return { ok: false, error: `Escolha um horário entre ${daySchedule.openTime || '18:00'} e ${daySchedule.closeTime || '23:00'}.` };
    }
    return { ok: true };
  }
  // ── POST /api/reservations — cliente pede uma reserva (fica pendente até a loja confirmar) ──
  if (pathname === '/api/reservations' && req.method === 'POST') {
    try {
      const { cfg } = readConfig();
      if (!cfg.reservations || !cfg.reservations.enabled) return sendJSON(res, 400, { error: 'Reserva de mesas está desativada no momento.' });
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 80);
      const phone = String(body.phone || '').trim().slice(0, 30);
      const people = Math.max(1, parseInt(body.people) || 0);
      const date = String(body.date || '').slice(0, 10);
      const time = String(body.time || '').slice(0, 5);
      if (!name || !phone) return sendJSON(res, 400, { error: 'Informe nome e telefone.' });
      if (!date || !time) return sendJSON(res, 400, { error: 'Escolha data e horário.' });
      if (!people) return sendJSON(res, 400, { error: 'Informe quantas pessoas.' });
      const slotCheck = isReservationSlotAvailable(cfg, date, time);
      if (!slotCheck.ok) return sendJSON(res, 400, { error: slotCheck.error });
      const maxP = Number(cfg.reservations.maxPeoplePerTable) || 12;
      if (people > maxP) return sendJSON(res, 400, { error: `Pra grupos maiores que ${maxP} pessoas, fale direto com a loja pelo WhatsApp.` });
      const list = readJSON(RESERVATIONS_FILE);
      const reservation = {
        id: 'RS' + Date.now().toString(36).toUpperCase(),
        createdAt: new Date().toISOString(),
        // v78: aceite automático de reservas — mesma ideia do aceite automático de pedidos
        // (Configurações → 🏪 Restaurante → 🤖 Automações). Quando ligado, a reserva já nasce
        // confirmada, sem precisar ninguém clicar em "Confirmar" no painel.
        status: cfg.autoAcceptReservations ? 'confirmada' : 'pendente',
        // v126 — BUG CORRIGIDO ("reserva imprimia mesmo com aceite automático desligado"): esse
        // campo usava `cfg.print` (só o interruptor GERAL de impressão automática), igual a
        // impressão automática de PEDIDO usava até a v91 — e foi corrigido lá pra usar
        // `cfg.autoAcceptOrders` na v92 (ver comentário logo abaixo, perto do broadcast de
        // 'new-order'), pelo mesmo motivo: sem o aceite automático ligado, a reserva fica
        // pendente esperando alguém CONFIRMAR manualmente no painel, e imprimir sozinha nesse
        // caso desperdiça papel se a loja recusar a reserva depois. Reserva nunca recebeu o
        // mesmo ajuste — ficou usando só `cfg.print` até agora. Corrigido pra espelhar o padrão
        // de pedido: só marca elegível pra impressão automática quando o aceite automático de
        // RESERVA (`cfg.autoAcceptReservations`) também está ligado. Diferente de pedido (que só
        // pode ser CRIADO com a loja aberta — cfg.open já trava lá em cima), reserva continua
        // podendo ser criada com a loja fechada de propósito (é o que permite reservar um dia
        // futuro com antecedência — ver o novo botão "📅 Nova Reserva" no painel), então aqui
        // cfg.open também entra direto na conta: se a reserva foi criada com a loja fechada,
        // ela não nasce elegível pra impressão automática (nem agora nem quando o Agente Local
        // reconectar depois via fila de recuperação) — só uma reserva criada com a loja já
        // aberta é que sai sozinha na impressora.
        autoPrintEligible: !!(cfg.autoAcceptReservations && Number(cfg.open)),
        name, phone, people, date, time,
        notes: String(body.notes || '').slice(0, 200),
        storeReply: '' // v33: mensagem da loja pro cliente (aparece na tela de acompanhamento)
      };
      list.unshift(reservation);
      writeJSON(RESERVATIONS_FILE, list);
      broadcast('new-reservation', reservation); // v39: avisa o painel em tempo real (som + toast), igual já acontece com pedido novo
      // v93 — NOVO ("reserva de mesa também deve imprimir"): mesma ideia da impressão automática
      // de pedido novo (cfg.print liga/desliga geral) — usa a impressora configurada pra via
      // "caixa" (é quem normalmente recebe o cliente/atende a reserva). Se essa via estiver
      // desativada ou sem impressora configurada, simplesmente não imprime nada (sem erro pro
      // cliente) — a reserva já foi salva e confirmada normalmente de qualquer jeito.
      // v126 — reforçado: além do interruptor geral (cfg.print), agora só imprime de verdade
      // se reservation.autoPrintEligible for true — ou seja, loja ABERTA agora (cfg.open) E
      // aceite automático de reserva ligado (cfg.autoAcceptReservations), calculado ali em
      // cima na criação do objeto (mesma regra pedida pra pedido também). A reserva continua
      // sendo CRIADA normalmente mesmo com a loja fechada (é assim que dá pra reservar com
      // antecedência pra um dia futuro, ver o botão "📅 Nova Reserva" no painel); só não sai
      // sozinha na impressora se tiver nascido fora do horário de funcionamento ou sem o
      // aceite automático ligado — nesses casos a loja confirma/imprime manualmente depois.
      if (Number(cfg.print) && reservation.autoPrintEligible) {
        const printerCfg = cfg.stations && cfg.stations.caixa;
        if (printerCfg && printerCfg.active !== false) {
          try {
            if (printerCfg.method === 'rede' && printerCfg.ip) {
              sendNetworkPrint(printerCfg.ip, printerCfg.port, buildReservationTicketText(reservation, cfg)).catch(() => {});
            } else if (printerCfg.method === 'usb' && printerCfg.device) {
              sendUSBPrint(printerCfg.device, buildReservationTicketText(reservation, cfg)).catch(() => {});
            } else if (printerCfg.method === 'automatica') {
              // o Agente Local escuta esse evento e monta a via sozinho (mesmo padrão de "new-order")
              broadcast('new-reservation-print', { ...reservation, _printFontSize: cfg.printSize, storeName: cfg.name });
            }
            // método "navegador": o próprio painel.html escuta "new-reservation" e abre a
            // janela de impressão do navegador quando essa via está configurada assim.
          } catch (e) { /* impressão de reserva é best-effort — nunca derruba a criação da reserva */ }
        }
      }
      // v79: mesmo alerta push simultâneo (PC + celular) que os pedidos novos já disparam.
      sendAdminPush({
        title: '🪑 Nova reserva!',
        body: `${reservation.name} · ${reservation.people} pessoa(s) · ${reservation.date} às ${reservation.time}`,
        url: '/painel.html',
        icon: '/icon-192.png',
        sound: 'oriental',
        // v81: tag por reserva — mesma correção do pedido novo, ver comentário lá em cima.
        tag: 'shogatsu-nova-reserva-' + reservation.id
      });
      return sendJSON(res, 201, { ok: true, reservation });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── GET /api/reservations — painel lista as reservas ──
  if (pathname === '/api/reservations' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, { reservations: readJSON(RESERVATIONS_FILE) });
  }
  // ── GET /api/track-reservation/:id — cliente acompanha status da própria reserva (público, v33) ──
  if (pathname.startsWith('/api/track-reservation/') && req.method === 'GET') {
    const id = decodeURIComponent(pathname.split('/').pop());
    const list = readJSON(RESERVATIONS_FILE);
    const r = list.find(x => x.id === id);
    if (!r) return sendJSON(res, 404, { error: 'Reserva não encontrada.' });
    const { phone, ...rest } = r; // não expõe o telefone de novo
    return sendJSON(res, 200, rest);
  }
  // ── POST /api/reservations/:id/status — painel confirma/recusa/cancela uma reserva ──
  if (pathname.match(/^\/api\/reservations\/[^/]+\/status$/) && req.method === 'POST') {
    if (!checkAuth(getToken(req, query))) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      const id = decodeURIComponent(pathname.split('/')[3]);
      const { status, reply } = await readBody(req);
      if (!['pendente', 'confirmada', 'recusada', 'cancelada'].includes(status)) return sendJSON(res, 400, { error: 'Status inválido.' });
      const list = readJSON(RESERVATIONS_FILE);
      const r = list.find(x => x.id === id);
      if (!r) return sendJSON(res, 404, { error: 'Reserva não encontrada.' });
      r.status = status;
      if (reply !== undefined) r.storeReply = String(reply).slice(0, 300); // v33: resposta da loja pro cliente
      writeJSON(RESERVATIONS_FILE, list);
      publicBroadcast('reservation-updated', { id }); // v33: avisa a tela do cliente em tempo real
      return sendJSON(res, 200, { ok: true, reservation: r });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── POST /api/orders — cria um novo pedido (cliente) ──
  // ── POST /api/coupon/validate — cliente digita um cupom no checkout, servidor confere ──
  if (pathname === '/api/coupon/validate' && req.method === 'POST') {
    try {
      const { code, subtotal } = await readBody(req);
      const { cfg } = readConfig();
      const result = findValidCoupon(cfg, code, Number(subtotal) || 0);
      if (result.error) return sendJSON(res, 200, { valid: false, error: result.error });
      return sendJSON(res, 200, {
        valid: true,
        code: result.coupon.code,
        type: result.coupon.type,
        discount: result.discount,
        freeDelivery: result.freeDelivery,
        message: result.coupon.type === 'frete_gratis' ? 'Frete grátis aplicado! 🎉' : `Desconto de R$ ${result.discount.toFixed(2).replace('.', ',')} aplicado! 🎉`
      });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  if (pathname === '/api/orders' && req.method === 'POST') {
    try {
      // v109: só entra aqui a checagem de permissão se for uma chamada LOGADA (pedido manual
      // batido pelo operador dentro do painel) — o cliente final faz pedido pelo site sem
      // nenhum login, então uma chamada sem token continua liberada normalmente (senão
      // quebraria o cardápio público). "pedidos.criar" só se aplica a quem já está logado.
      const staffSession = getSession(getToken(req, query));
      if (staffSession && !hasPermission(staffSession, 'pedidos', 'criar')) {
        return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra criar pedidos.' });
      }
      const body = await readBody(req);
      const { cfg, menu } = readConfig();
      if (!Number(cfg.open)) return sendJSON(res, 400, { error: 'Restaurante fechado no momento.' });
      if (!body.items || !body.items.length) return sendJSON(res, 400, { error: 'Carrinho vazio.' });

      // v105 — AUDITORIA — IDEMPOTÊNCIA (evita pedido duplicado em clique duplo/retry após
      // queda de conexão): o cliente manda uma "idempotencyKey" única gerada por tentativa de
      // checkout. Se essa chave já corresponder a um pedido existente, devolve o pedido já
      // criado em vez de criar outro — cobre exatamente o caso "servidor salvou mas a resposta
      // não chegou ao cliente, que tenta de novo". Checagem cedo (best-effort) aqui; a checagem
      // que realmente decide é a repetida logo antes de gravar (mais abaixo), sem nenhum
      // "await" entre ela e a gravação, pra fechar a janela de corrida.
      const idempotencyKey = String(body.idempotencyKey || '').slice(0, 80) || null;
      if (idempotencyKey) {
        const early = readJSON(ORDERS_FILE).find(o => o.idempotencyKey === idempotencyKey);
        if (early) return sendJSON(res, 200, { ok: true, order: early, duplicate: true });
      }

      // BUG DE SEGURANÇA CORRIGIDO: o servidor aceitava sem checar nenhuma o preço de cada item
      // exatamente como o navegador do cliente mandava — bastava editar a requisição (ex: pelo
      // DevTools) pra "pagar" qualquer prato a R$0,01. Agora todo preço é comparado contra o menor
      // preço realmente cadastrado no cardápio (contando variações/combos, que somam ao preço base);
      // preços zerados, negativos ou abaixo do mínimo possível do cardápio derrubam o pedido.
      const allMenuPrices = [];
      (menu || []).forEach(cat => (cat.items || []).forEach(it => {
        allMenuPrices.push(Number(it.price) || 0);
        (it.variantGroups || []).forEach(g => (g.options || []).forEach(o => {
          if (Number(o.priceDelta) < 0) allMenuPrices.push((Number(it.price) || 0) + Number(o.priceDelta));
        }));
      }));
      const minMenuPrice = allMenuPrices.length ? Math.min(...allMenuPrices.filter(p => p > 0)) : 0;
      for (const it of body.items) {
        const p = Number(it.price);
        if (!(p > 0) || (minMenuPrice > 0 && p < minMenuPrice - 0.01)) {
          return sendJSON(res, 400, { error: `Preço inválido para "${String(it.name || 'item').slice(0, 80)}". Atualize a página e tente novamente.` });
        }
      }

      // Recalcula o cupom no servidor (nunca confia no desconto que o cliente mandou),
      // pra evitar que alguém edite o total pelo navegador e finja um desconto maior.
      const subtotalNum = Number(body.subtotal) || 0;
      let appliedCoupon = null, discount = 0;
      const couponCodeInput = String(body.couponCode || '').trim();
      if (couponCodeInput) {
        const result = findValidCoupon(cfg, couponCodeInput, subtotalNum);
        if (result.coupon) { appliedCoupon = result.coupon; discount = result.discount || 0; }
      }
      const feeNum = appliedCoupon && appliedCoupon.type === 'frete_gratis' ? 0 : (Number(body.fee) || 0);

      // Resgate de pontos de fidelidade — nunca confia no valor de desconto que o cliente mandou,
      // recalcula o saldo real de pontos no servidor a partir do histórico de pedidos.
      let pointsRedeemed = 0, pointsDiscount = 0;
      const loyaltyCfg = cfg.loyalty || {};
      const requestedPoints = Math.max(0, parseInt(body.redeemPoints) || 0);
      if (loyaltyCfg.enabled && requestedPoints > 0 && String(body.phone || '').trim()) {
        const ordersNow = readJSON(ORDERS_FILE);
        const bal = loyaltyBalance(body.phone, ordersNow, cfg);
        const usablePoints = Math.min(requestedPoints, bal.balance);
        const blocks = Math.floor(usablePoints / (loyaltyCfg.redeemPoints || 100));
        if (blocks > 0 && subtotalNum >= (Number(loyaltyCfg.minOrderToRedeem) || 0)) {
          pointsRedeemed = blocks * (loyaltyCfg.redeemPoints || 100);
          pointsDiscount = blocks * (Number(loyaltyCfg.redeemValue) || 0);
        }
      }

      const totalNum = Math.max(0, subtotalNum + feeNum - discount - pointsDiscount);
      const pointsEarned = loyaltyCfg.enabled ? Math.floor(totalNum * (Number(loyaltyCfg.pointsPerReal) || 0)) : 0;

      // v105 — AUDITORIA — BUG CRÍTICO ENCONTRADO E CORRIGIDO ("pedidos reais somem"): o pedido
      // era montado a partir de `orders = readJSON(ORDERS_FILE)` lido AQUI, mas logo abaixo
      // havia um `await geocodeAddress(...)` (chamada de rede pra achar as coordenadas do
      // endereço) ANTES de `orders.unshift(order); writeJSON(ORDERS_FILE, orders)`. Nesse
      // intervalo (rede lenta, Wi-Fi instável, geocoding demorando), o event loop do Node fica
      // livre pra atender OUTRA requisição de pedido em paralelo — que lê o mesmo orders.json
      // (ainda sem o pedido A), grava o pedido B normalmente e responde "sucesso" ao cliente B.
      // Quando o pedido A termina o geocode e finalmente grava, ele grava a SUA cópia em
      // memória do array (que não tem o pedido B) — sobrescrevendo o arquivo e apagando o
      // pedido B, que o cliente B já tinha certeza de ter feito. Dois pedidos reais chegando
      // perto um do outro, com pelo menos um em modo delivery (dispara geocode), bastava pra
      // sumir um pedido de verdade. CORREÇÃO: geocodificar o endereço ANTES de tocar no
      // orders.json, e fazer a leitura+gravação do arquivo como um bloco síncrono sem nenhum
      // "await" no meio — o Node nunca interrompe um trecho síncrono pra atender outra
      // requisição, então essa janela de corrida deixa de existir.
      let geoResult = null;
      if ((body.mode === 'retirada' ? 'retirada' : 'delivery') === 'delivery' && String(body.address || '').trim()) {
        try { geoResult = await geocodeAddress(String(body.address).slice(0, 200) + ', Brasil'); }
        catch (e) { /* mapa fica sem o marcador do cliente, sem afetar o pedido */ }
      }

      // Leitura "fresca" do arquivo, feita o mais perto possível da gravação (sem nenhum
      // await entre esta linha e o writeJSON lá embaixo) — fecha a janela de corrida descrita
      // acima. Idempotência checada de novo aqui por segurança (a checagem "early" lá em cima
      // não cobre uma tentativa concorrente que só grava exatamente entre as duas leituras).
      const orders = readJSON(ORDERS_FILE);
      if (idempotencyKey) {
        const dupNow = orders.find(o => o.idempotencyKey === idempotencyKey);
        if (dupNow) return sendJSON(res, 200, { ok: true, order: dupNow, duplicate: true });
      }
      const order = {
        id: 'SG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
        idempotencyKey,
        ticketNumber: null, // só é atribuído quando a loja ACEITA o pedido (veja PATCH /api/orders/:id)
        createdAt: new Date().toISOString(),
        status: 'novo',
        // v125-part1: marca no próprio pedido se ele nasceu elegível para impressão automática.
        // Isso permite recuperar pedidos perdidos durante uma queda de SSE/rede sem imprimir
        // pedidos que só foram aceitos manualmente depois.
        autoPrintEligible: !!cfg.autoAcceptOrders,
        autoPrinted: {}, // v86: ver POST /api/print — evita a mesma via imprimir 2-3x com vários painéis abertos
        mode: body.mode === 'retirada' ? 'retirada' : 'delivery',
        name: String(body.name || '').slice(0, 80),
        phone: String(body.phone || '').slice(0, 30),
        address: String(body.address || '').slice(0, 200),
        // v73: bairro separado (usado no Relatório de Taxas de Motoboy). Se o checkout mandar
        // explicitamente (body.hood), usa ele; senão tenta extrair do texto do endereço.
        hood: String(body.hood || extractHoodFromAddress(body.address)).slice(0, 60),
        items: (body.items || []).slice(0, 60).map(i => {
          // v49 — BUG CORRIGIDO ("impressora não imprime"): essa lista só aceitava 3 vias
          // (cozinha/sushibar/bar) — um item marcado pra "delivery", "expedição" ou uma via
          // customizada tinha a marcação APAGADA bem aqui, no exato instante em que o pedido
          // era criado, e caía sempre em "cozinha" sem aviso nenhum. Agora usa as vias reais
          // configuradas no sistema (cfg.stations), então qualquer via nova funciona de verdade.
          const validStations = Object.keys(cfg.stations || {});
          const fallbackStation = cfg.defaultStation && validStations.includes(cfg.defaultStation) ? cfg.defaultStation : 'cozinha';
          let stations = Array.isArray(i.stations) ? i.stations.filter(s => validStations.includes(s)) : [];
          if (!stations.length) stations = [validStations.includes(i.station) ? i.station : fallbackStation];
          return {
            name: String(i.name || '').slice(0, 80),
            qty: Math.max(1, parseInt(i.qty) || 1),
            price: Number(i.price) || 0,
            stations: [...new Set(stations)]
          };
        }),
        obs: String(body.obs || '').slice(0, 300),
        // v26: agendamento — cliente escolhe um horário futuro pra retirada/entrega em vez de "o quanto antes".
        // Validado contra a janela configurada (mínimo de antecedência e máximo de dias); fora da janela, ignora
        // o agendamento e o pedido segue como "o quanto antes" (nunca bloqueia o pedido por causa disso).
        scheduledFor: (() => {
          if (!body.scheduledFor) return null;
          const d = new Date(body.scheduledFor);
          if (isNaN(d.getTime())) return null;
          const sc = cfg.scheduling || {};
          const minAt = Date.now() + (Number(sc.minMinutesAhead) || 0) * 60000;
          const maxAt = Date.now() + (Number(sc.maxDaysAhead) || 7) * 86400000;
          if (d.getTime() < minAt || d.getTime() > maxAt) return null;
          return d.toISOString();
        })(),
        payMethod: String(body.payMethod || '').slice(0, 20),
        troco: String(body.troco || '').slice(0, 20),
        subtotal: subtotalNum,
        fee: feeNum,
        couponCode: appliedCoupon ? appliedCoupon.code : '',
        discount,
        pointsRedeemed,
        pointsDiscount,
        pointsEarned,
        total: totalNum,
        // v22: status de pagamento — 'pix' pode ser confirmado automaticamente (gateway) ou manualmente
        // (botão no painel); outras formas de pagamento (dinheiro/cartão na entrega) começam já "pagas"
        // do ponto de vista do fluxo, já que são conferidas na hora da entrega, não antes.
        paid: body.payMethod !== 'pix',
        paidAt: null,
        paidVia: null,
        // v27: coordenadas do endereço de entrega, pra mostrar no mapa da tela de acompanhamento.
        // Busca melhor-esforço — se a geocodificação falhar (endereço incompleto, serviço fora do ar),
        // o pedido segue normal, só sem o marcador do cliente no mapa.
        // v105 — AUDITORIA: geocodificado ANTES deste bloco (variável `geoResult`), não mais
        // aqui — ver o comentário grande logo acima de "const orders = readJSON(ORDERS_FILE)"
        // sobre por que isso precisou sair do meio do read-modify-write do orders.json.
        customerLat: geoResult ? geoResult.lat : null,
        customerLng: geoResult ? geoResult.lng : null,
        // v34: localização ao vivo do motoboy durante a entrega (rastreamento pro cliente).
        // Só é preenchida enquanto status === 'saiu' — ver /api/courier/location e /api/track.
        courierLat: null,
        courierLng: null,
        courierLocationAt: null
      };
      // v55: aceite automático de pedidos — se a chave estiver ligada (Configurações →
      // aceite automático, ou o interruptor na barra lateral do painel), o pedido já nasce
      // ACEITO (status "preparando"), com número de ficha já atribuído — igual ao que
      // acontece quando alguém clica em "Aceitar Pedido" manualmente. Sem isso, um pedido
      // impresso automaticamente (via "🤖 Automática") saía sem número de ficha, porque o
      // número só era atribuído no clique manual de aceite; combinando as duas coisas, a
      // impressão automática já sai com o número certinho, sem ninguém precisar tocar em nada.
      if (cfg.autoAcceptOrders) {
        order.status = 'preparando';
        let next = Number(cfg.nextTicketNumber) >= 1 && Number(cfg.nextTicketNumber) <= 200 ? Number(cfg.nextTicketNumber) : 1;
        const activeNumbers = new Set(orders.filter(o => o.ticketNumber && !['entregue', 'cancelado'].includes(o.status)).map(o => o.ticketNumber));
        for (let i = 0; i < 200 && activeNumbers.has(next); i++) next = next >= 200 ? 1 : next + 1;
        order.ticketNumber = next;
        const cfgData = readConfig();
        cfgData.cfg.nextTicketNumber = next >= 200 ? 1 : next + 1;
        writeJSON(CONFIG_FILE, cfgData);
      }

      orders.unshift(order);
      writeJSON(ORDERS_FILE, orders);

      // Contabiliza o uso do cupom (pra respeitar o limite de usos configurado)
      if (appliedCoupon) {
        const data = readConfig();
        const c = (data.cfg.coupons || []).find(x => String(x.code || '').toUpperCase() === appliedCoupon.code.toUpperCase());
        if (c) { c.usedCount = (c.usedCount || 0) + 1; writeJSON(CONFIG_FILE, data); }
      }

      // Se o telefone tem conta cadastrada, guarda o endereço mais recente pra pré-preencher da próxima vez
      if (order.mode === 'delivery') {
        const customers = readJSON(CUSTOMERS_FILE);
        const customer = findCustomer(customers, order.phone);
        if (customer) {
          customer.lastAddress = order.address;
          writeJSON(CUSTOMERS_FILE, customers);
        }
      }

      // v92 — BUG CORRIGIDO ("não deve imprimir se botão de aceite automático estiver
      // desligado"): a impressão automática sempre foi pensada pra andar junto do aceite
      // automático (pedido já nasce com número de ficha atribuído — ver comentário acima). Sem
      // aceite automático ligado, o pedido nasce "novo" (pendente), esperando alguém olhar e
      // aceitar manualmente no painel — imprimir sozinho nesse caso faz a via sair sem número
      // de ficha nenhum, e o papel pode ser desperdiçado se o pedido for recusado/cancelado
      // antes de alguém olhar. O Agente Local agora só imprime automaticamente quando essa
      // flag vier true; a impressão manual (botão "🖨 Imprimir" no painel) continua funcionando
      // sempre, com ou sem aceite automático ligado.
      broadcast('new-order', { ...order, _printFontSize: cfg.printSize, _autoAcceptOn: !!cfg.autoAcceptOrders, _deliveryWindow: estimateDeliveryWindow(order, cfg) });
      // v79: alerta push pra loja em todos os aparelhos ativados (PC + celular simultâneo) —
      // além do som/SSE de quem já está com o painel aberto na tela. Não trava a resposta ao
      // cliente: dispara e segue (a função nunca rejeita, então não precisa de .catch aqui).
      sendAdminPush({
        title: '🔔 Novo pedido!',
        body: `${order.name || 'Cliente'} · ${order.mode === 'delivery' ? 'Delivery' : 'Retirada'} · R$ ${Number(order.total || 0).toFixed(2)}`,
        url: '/painel.html',
        icon: '/icon-192.png',
        sound: 'oriental',
        // v81: BUG CORRIGIDO — tag por pedido (antes era sempre a mesma "shogatsu-novo-pedido"
        // pra todo pedido novo). Com a mesma tag, um segundo pedido chegando antes do primeiro
        // alerta ser visto SUBSTITUÍA o anterior na tela — e substituição de notificação com a
        // mesma tag não re-toca som/vibração por padrão, então na prática o alerta "sumia" sem
        // avisar ninguém. Agora cada pedido empilha o próprio alerta.
        tag: 'shogatsu-novo-pedido-' + order.id
      });
      return sendJSON(res, 201, { ok: true, order });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/orders — lista pedidos (painel, requer auth) ──
  if (pathname === '/api/orders' && req.method === 'GET') {
    const session = getSession(getToken(req, query));
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });
    if (!hasPermission(session, 'pedidos', 'ver')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver os pedidos.' });
    return sendJSON(res, 200, readJSON(ORDERS_FILE));
  }

  // ── PATCH /api/orders/:id — atualiza status (painel) ──
  if (pathname.startsWith('/api/orders/') && req.method === 'PATCH') {
    const session = getSession(getToken(req, query));
    if (!session) return sendJSON(res, 401, { error: 'unauthorized' });
    const id = pathname.split('/').pop();
    try {
      const { status, fee, cancelReason, cancelledBy, ticketNumber, courierName } = await readBody(req);
      const valid = ['novo', 'preparando', 'saiu', 'entregue', 'cancelado'];
      if (!valid.includes(status)) return sendJSON(res, 400, { error: 'status inválido' });
      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === id);
      if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
      // v107 — checagem de permissão AQUI no backend (nunca só na interface): confere se o
      // papel da sessão pode mesmo fazer ESSA transição de status específica para ESTE pedido.
      if (!canChangeOrderStatus(session, order.status, status)) {
        return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra mudar esse pedido de status.' });
      }
      const statusChanged = order.status !== status;
      order.status = status;
      // v27: nome do entregador (opcional) — aparece pro cliente na tela de acompanhamento quando o pedido sai.
      if (courierName !== undefined) order.courierName = String(courierName || '').slice(0, 60) || null;
      if (ticketNumber !== undefined && ticketNumber !== null && ticketNumber !== '') {
        const n = parseInt(ticketNumber);
        if (n >= 1 && n <= 200) {
          // Não deixa dois pedidos AINDA EM ANDAMENTO usarem o mesmo número — evita
          // confusão na hora de chamar ("Pedido nº 12!") com dois pedidos diferentes.
          // Pedidos já entregues/cancelados liberam o número de novo pra reuso normal do ciclo.
          const conflict = orders.find(o => o.id !== id && o.ticketNumber === n && !['entregue', 'cancelado'].includes(o.status));
          if (conflict) {
            return sendJSON(res, 400, { error: `O número ${n} já está sendo usado pelo pedido em andamento ${conflict.id}. Escolha outro número.` });
          }
          order.ticketNumber = n;
        }
      } else if (status === 'preparando' && !order.ticketNumber) {
        // Loja aceitou o pedido sem escolher um número manualmente — atribui o próximo da fila (1 a 200, cíclico),
        // pulando qualquer número que já esteja em uso por outro pedido ainda em andamento.
        const cfgData = readConfig();
        let next = Number(cfgData.cfg.nextTicketNumber) >= 1 && Number(cfgData.cfg.nextTicketNumber) <= 200 ? Number(cfgData.cfg.nextTicketNumber) : 1;
        const activeNumbers = new Set(orders.filter(o => o.id !== id && o.ticketNumber && !['entregue', 'cancelado'].includes(o.status)).map(o => o.ticketNumber));
        for (let i = 0; i < 200 && activeNumbers.has(next); i++) next = next >= 200 ? 1 : next + 1;
        order.ticketNumber = next;
        cfgData.cfg.nextTicketNumber = next >= 200 ? 1 : next + 1;
        writeJSON(CONFIG_FILE, cfgData);
      }
      if (status === 'cancelado') {
        order.cancelReason = String(cancelReason || '').slice(0, 200) || 'Não informado';
        order.cancelledBy = ['loja', 'cliente'].includes(cancelledBy) ? cancelledBy : 'loja';
      }
      // v34: guarda quando o pedido foi de fato entregue — sem isso não dá pra calcular o
      // tempo médio real (o dashboard só mostrava o texto configurado, não um cálculo de verdade).
      if (status === 'entregue' && !order.deliveredAt) {
        order.deliveredAt = new Date().toISOString();
      }
      // v34: entrega encerrada (entregue ou cancelada) — apaga a última posição do motoboy.
      // Não é só esconder na resposta: some do registro mesmo, pra não ficar guardado sem necessidade.
      if (['entregue', 'cancelado'].includes(status)) {
        order.courierLat = null;
        order.courierLng = null;
        order.courierLocationAt = null;
      }
      if (fee !== undefined && fee !== null && fee !== '') {
        order.fee = Number(fee) || 0;
        order.total = Math.max(0, Number(order.subtotal || 0) + order.fee - Number(order.discount || 0));
      }
      writeJSON(ORDERS_FILE, orders);
      broadcast('order-updated', order);

      // v21: notificação automática de WhatsApp (se configurado) — não bloqueia a resposta ao painel;
      // se falhar (conta Twilio não configurada, número inválido, etc.) só ignora, sem quebrar nada.
      const notifCfg = readConfig().cfg;
      if (notifCfg.sms && notifCfg.sms.notifyWhatsApp && WHATSAPP_STATUS_MESSAGES[order.status] && order.phone) {
        const msg = WHATSAPP_STATUS_MESSAGES[order.status](order, notifCfg);
        sendWhatsApp(order.phone, msg, notifCfg.sms).catch(() => {});
      }
      // v27: notificação push automática quando o status muda (independente do WhatsApp) —
      // só alcança quem ativou notificações E tem o telefone vinculado à inscrição.
      if (statusChanged && PUSH_STATUS_MESSAGES[order.status] && order.phone && notifCfg.vapid && notifCfg.vapid.publicKey) {
        (async () => {
          try {
            const p = normalizePhone(order.phone);
            const subs = readJSON(PUSH_SUBS_FILE).filter(s => s.phone === p);
            if (!subs.length) return;
            const { title, body } = PUSH_STATUS_MESSAGES[order.status](order, notifCfg);
            const payload = { title, body, url: '/?track=' + order.id, icon: '/icon-192.png' };
            for (const sub of subs) await webpush.sendWebPush(sub, payload, notifCfg.vapid, notifCfg.vapid.subject);
          } catch (e) { /* nunca deve derrubar a atualização do pedido por causa disso */ }
        })();
      }

      return sendJSON(res, 200, { ok: true, order });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── DELETE /api/admin/orders/:id — remove um pedido DEFINITIVAMENTE do sistema (v32/v33) ──
  // Diferente do cancelamento (que só muda o status e mantém o pedido no histórico), isso apaga
  // o registro por completo. v33: restrito só ao usuário MASTER, e exige especificamente a
  // SENHA MASTER de novo (não aceita senha de admin comum nem de usuário qualquer), mesmo com a
  // sessão já logada. Guarda tudo num histórico separado (data/delete-log.json).
  if (pathname.match(/^\/api\/admin\/orders\/[^/]+$/) && req.method === 'DELETE') {
    const session = getSession(getToken(req, query));
    if (!session || (ROLE_RANK[session.role] || 0) < ROLE_RANK.master) {
      return sendJSON(res, 403, { error: 'Somente o usuário MASTER pode excluir pedidos do sistema.' });
    }
    try {
      const id = decodeURIComponent(pathname.split('/').pop());
      const { password } = await readBody(req);
      const { cfg } = readConfig();

      // v33: confere especificamente a SENHA MASTER de novo (reautenticação), não aceita mais
      // senha de admin comum nem de outros usuários.
      const passOk = !!password && password === cfg.masterPass;
      if (!passOk) {
        return sendJSON(res, 403, { error: '❌ Senha inválida. Pedido não foi removido.' });
      }

      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === id);
      if (!order) return sendJSON(res, 404, { error: 'Pedido não encontrado.' });

      const remaining = orders.filter(o => o.id !== id);
      writeJSON(ORDERS_FILE, remaining);

      const log = readJSON(DELETE_LOG_FILE);
      log.unshift({
        orderId: id,
        orderSummary: { name: order.name, total: order.total, status: order.status, createdAt: order.createdAt },
        deletedAt: new Date().toISOString(),
        deletedBy: session.username,
        deletedByRole: session.role
      });
      writeJSON(DELETE_LOG_FILE, log.slice(0, 500)); // mantém só as 500 exclusões mais recentes

      broadcast('order-deleted', { id });
      return sendJSON(res, 200, { ok: true, message: '✅ Pedido removido do sistema com sucesso.' });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/admin/delete-log — histórico de exclusões de pedidos (só master) ──
  if (pathname === '/api/admin/delete-log' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'sistema', 'logs')) return sendJSON(res, 403, { error: 'Só o usuário master pode ver o histórico de exclusões.' });
    return sendJSON(res, 200, { log: readJSON(DELETE_LOG_FILE) });
  }

  // ═══════════════════════════════════════════════════════════
  // RESET DE DADOS (v34) — Configurações → ⚠️ Zona de Perigo.
  // Só master, sempre com reautenticação por senha master, sempre registrado no histórico
  // de auditoria (o mesmo delete-log.json usado pra exclusão de pedidos).
  // ═══════════════════════════════════════════════════════════
  // ── POST /api/admin/reset-menu — restaura o cardápio pro padrão de fábrica ──
  if (pathname === '/api/admin/reset-menu' && req.method === 'POST') {
    const session = getSession(getToken(req, query));
    if (!session || (ROLE_RANK[session.role] || 0) < ROLE_RANK.master) {
      return sendJSON(res, 403, { error: 'Somente o usuário MASTER pode restaurar o cardápio.' });
    }
    try {
      const { password } = await readBody(req);
      const { cfg } = readConfig();
      if (!password || password !== cfg.masterPass) return sendJSON(res, 403, { error: '❌ Senha inválida. Cardápio não foi restaurado.' });
      const data = readConfig();
      data.menu = JSON.parse(JSON.stringify(DEFAULT_MENU)); // cópia limpa, sem referenciar o objeto original
      writeJSON(CONFIG_FILE, data);
      const log = readJSON(DELETE_LOG_FILE);
      log.unshift({ action: 'reset-menu', deletedAt: new Date().toISOString(), deletedBy: session.username, deletedByRole: session.role });
      writeJSON(DELETE_LOG_FILE, log.slice(0, 500));
      publicBroadcast('menu-updated', {});
      return sendJSON(res, 200, { ok: true, message: '✅ Cardápio restaurado para o padrão de fábrica.' });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/admin/reset-orders — apaga TODO o histórico de pedidos ──
  if (pathname === '/api/admin/reset-orders' && req.method === 'POST') {
    const session = getSession(getToken(req, query));
    if (!session || (ROLE_RANK[session.role] || 0) < ROLE_RANK.master) {
      return sendJSON(res, 403, { error: 'Somente o usuário MASTER pode apagar o histórico de pedidos.' });
    }
    try {
      const { password } = await readBody(req);
      const { cfg } = readConfig();
      if (!password || password !== cfg.masterPass) return sendJSON(res, 403, { error: '❌ Senha inválida. Histórico não foi apagado.' });
      const countBefore = readJSON(ORDERS_FILE).length;
      writeJSON(ORDERS_FILE, []);
      const log = readJSON(DELETE_LOG_FILE);
      log.unshift({ action: 'reset-orders', ordersRemoved: countBefore, deletedAt: new Date().toISOString(), deletedBy: session.username, deletedByRole: session.role });
      writeJSON(DELETE_LOG_FILE, log.slice(0, 500));
      broadcast('order-updated', {});
      return sendJSON(res, 200, { ok: true, message: `✅ Histórico apagado (${countBefore} pedido(s) removido(s)).` });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }
  // ── POST /api/admin/reset-reservations — apaga TODO o histórico de reservas de mesa (v35) ──
  if (pathname === '/api/admin/reset-reservations' && req.method === 'POST') {
    const session = getSession(getToken(req, query));
    if (!session || (ROLE_RANK[session.role] || 0) < ROLE_RANK.master) {
      return sendJSON(res, 403, { error: 'Somente o usuário MASTER pode apagar o histórico de reservas.' });
    }
    try {
      const { password } = await readBody(req);
      const { cfg } = readConfig();
      if (!password || password !== cfg.masterPass) return sendJSON(res, 403, { error: '❌ Senha inválida. Histórico não foi apagado.' });
      const countBefore = readJSON(RESERVATIONS_FILE).length;
      writeJSON(RESERVATIONS_FILE, []);
      const log = readJSON(DELETE_LOG_FILE);
      log.unshift({ action: 'reset-reservations', reservationsRemoved: countBefore, deletedAt: new Date().toISOString(), deletedBy: session.username, deletedByRole: session.role });
      writeJSON(DELETE_LOG_FILE, log.slice(0, 500));
      return sendJSON(res, 200, { ok: true, message: `✅ Histórico de reservas apagado (${countBefore} reserva(s) removida(s)).` });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }


  if (pathname.startsWith('/api/track/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const orders = readJSON(ORDERS_FILE);
    const order = orders.find(o => o.id === id);
    if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
    const { name, phone, address, ...rest } = order;
    // v34: a localização do motoboy só é exposta pro cliente enquanto o pedido está
    // "saiu para entrega" — antes disso (ainda não saiu) ou depois (já entregue/cancelado),
    // não faz sentido mostrar e o motoboy não deve continuar rastreável.
    if (order.status !== 'saiu') { rest.courierLat = null; rest.courierLng = null; rest.courierLocationAt = null; }
    return sendJSON(res, 200, rest); // não expõe dados pessoais de novo, só status/itens/valores
  }

  // ── POST /api/courier/location/:id — o motoboy manda a posição do GPS enquanto entrega (v34) ──
  // Sem login: o próprio id do pedido funciona como o "convite" (igual o /api/track já faz).
  // Só aceita e só grava enquanto o pedido está "saiu" — fora dessa janela, recusa.
  if (pathname.startsWith('/api/courier/location/') && req.method === 'POST') {
    const id = decodeURIComponent(pathname.split('/').pop());
    try {
      const { lat, lng } = await readBody(req);
      const latNum = Number(lat), lngNum = Number(lng);
      if (!isFinite(latNum) || !isFinite(lngNum)) return sendJSON(res, 400, { error: 'coordenadas inválidas' });
      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === id);
      if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
      if (order.status !== 'saiu') {
        // Entrega já terminou (ou ainda nem saiu) — avisa o app do motoboy pra ele parar de mandar.
        return sendJSON(res, 200, { ok: false, ended: true, status: order.status });
      }
      order.courierLat = latNum;
      order.courierLng = lngNum;
      order.courierLocationAt = new Date().toISOString();
      writeJSON(ORDERS_FILE, orders);
      broadcast('order-updated', order);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/courier/order/:id — o app do motoboy usa isso pra saber o endereço da entrega (v34) ──
  // Só devolve os dados enquanto o pedido está em andamento (preparando ou saiu); depois de
  // entregue/cancelado, devolve só um aviso — o motoboy não continua vendo endereço de entregas antigas.
  if (pathname.startsWith('/api/courier/order/') && req.method === 'GET') {
    const id = decodeURIComponent(pathname.split('/').pop());
    const orders = readJSON(ORDERS_FILE);
    const order = orders.find(o => o.id === id);
    if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
    if (!['preparando', 'saiu'].includes(order.status)) {
      return sendJSON(res, 200, { ended: true, status: order.status });
    }
    return sendJSON(res, 200, {
      ended: false,
      id: order.id,
      ticketNumber: order.ticketNumber,
      status: order.status,
      mode: order.mode,
      name: order.name,
      phone: order.phone,
      address: order.address,
      obs: order.obs || ''
    });
  }

  // ── POST /api/orders/:id/received — cliente confirma que recebeu o pedido ──
  if (pathname.match(/^\/api\/orders\/[^/]+\/received$/) && req.method === 'POST') {
    const id = pathname.split('/')[3];
    const orders = readJSON(ORDERS_FILE);
    const order = orders.find(o => o.id === id);
    if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
    order.receivedByCustomer = true;
    order.receivedAt = new Date().toISOString();
    writeJSON(ORDERS_FILE, orders);
    // v45: antes essa confirmação só ficava salva no pedido, sem avisar ninguém — a equipe só
    // ficava sabendo se abrisse o pedido manualmente. Agora avisa o painel na hora (toast).
    broadcast('order-updated', order);
    return sendJSON(res, 200, { ok: true });
  }

  // ── POST /api/orders/:id/review — cliente avalia o pedido (1 a 5 estrelas + comentário) ──
  if (pathname.match(/^\/api\/orders\/[^/]+\/review$/) && req.method === 'POST') {
    const id = pathname.split('/')[3];
    try {
      const { stars, comment } = await readBody(req);
      const n = parseInt(stars);
      if (!(n >= 1 && n <= 5)) return sendJSON(res, 400, { error: 'A avaliação precisa ser de 1 a 5 estrelas.' });
      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === id);
      if (!order) return sendJSON(res, 404, { error: 'pedido não encontrado' });
      if (order.review) return sendJSON(res, 400, { error: 'Esse pedido já foi avaliado.' });
      order.review = { stars: n, comment: String(comment || '').slice(0, 400), createdAt: new Date().toISOString(), hidden: false };
      writeJSON(ORDERS_FILE, orders);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/reviews — avaliações públicas e visíveis, pra mostrar no site ──
  if (pathname === '/api/reviews' && req.method === 'GET') {
    const orders = readJSON(ORDERS_FILE);
    const reviews = orders
      .filter(o => o.review && !o.review.hidden)
      .map(o => ({
        name: String(o.name || 'Cliente').trim().split(' ')[0], // só o primeiro nome, por privacidade
        stars: o.review.stars,
        comment: o.review.comment,
        createdAt: o.review.createdAt
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50);
    const avg = reviews.length ? Math.round((reviews.reduce((s, r) => s + r.stars, 0) / reviews.length) * 10) / 10 : null;
    return sendJSON(res, 200, { reviews, average: avg, count: reviews.length });
  }

  // ── GET /api/admin/reviews — todas as avaliações (inclusive ocultas), pra moderação ──
  if (pathname === '/api/admin/reviews' && req.method === 'GET') {
    if (!requirePermission(getToken(req, query), 'relatorios', 'ver')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra ver as avaliações.' });
    const orders = readJSON(ORDERS_FILE);
    const reviews = orders
      .filter(o => o.review)
      .map(o => ({ orderId: o.id, ticketNumber: o.ticketNumber, name: o.name, ...o.review }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJSON(res, 200, { reviews });
  }

  // ── PATCH /api/admin/reviews/:orderId — oculta ou reexibe uma avaliação ──
  if (pathname.match(/^\/api\/admin\/reviews\/[^/]+$/) && req.method === 'PATCH') {
    if (!requirePermission(getToken(req, query), 'restaurante', 'editarInformacoes')) return sendJSON(res, 403, { error: 'Seu usuário não tem permissão pra moderar avaliações.' });
    const orderId = pathname.split('/').pop();
    try {
      const { hidden } = await readBody(req);
      const orders = readJSON(ORDERS_FILE);
      const order = orders.find(o => o.id === orderId);
      if (!order || !order.review) return sendJSON(res, 404, { error: 'Avaliação não encontrada.' });
      order.review.hidden = !!hidden;
      writeJSON(ORDERS_FILE, orders);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { error: 'invalid body' }); }
  }

  // ── GET /api/stream — Server-Sent Events (painel em tempo real) ──
  if (pathname === '/api/stream' && req.method === 'GET') {
    if (!checkAuth(getToken(req, query))) { res.writeHead(401); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
  }

  // ── GET /api/public-stream — SSE público (site do cliente), avisa quando o cardápio/config muda ──
  if (pathname === '/api/public-stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    publicSseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(keepAlive); publicSseClients.delete(res); });
    return;
  }

  // ── Arquivos estáticos (site do cliente + painel) ──
  // v70: HEAD também precisa funcionar aqui — antes só GET era aceito, e ferramentas que checam
  // se uma imagem existe com HEAD (alguns proxies, monitoramento, pré-carregadores) recebiam 404
  // mesmo com o arquivo existindo normalmente.
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  res.writeHead(404); res.end('Not found');
}

// v79: calcula a PRÓXIMA data de envio de uma campanha recorrente, a partir da última data
// programada (não da hora atual) — assim o horário do dia sempre fica igual ao que foi
// escolhido no agendamento, mesmo que o servidor demore um pouco pra rodar o checador.
function computeNextSend(fromISO, recurrence, intervalMinutes) {
  const d = new Date(fromISO);
  // v80: "hourly" repete VÁRIAS VEZES NO MESMO DIA, de X em X minutos (intervalMinutes) —
  // as outras opções (daily/weekly/monthly) continuam no máximo 1x por dia.
  if (recurrence === 'hourly') d.setMinutes(d.getMinutes() + (Number(intervalMinutes) || 240));
  else if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}
// v79: roda a cada 1 minuto — dispara qualquer campanha agendada cuja hora já chegou. Uma
// campanha "uma vez" desativa sozinha depois de enviar; uma recorrente calcula e agenda a
// próxima ocorrência automaticamente (diária/semanal/mensal), sem precisar reagendar na mão.
async function checkScheduledPush() {
  try {
    const list = readJSON(SCHEDULED_PUSH_FILE);
    if (!list.length) return;
    const { cfg } = readConfig();
    if (!cfg.vapid || !cfg.vapid.publicKey || !cfg.vapid.privateKeyJwk) return;
    const now = Date.now();
    let changed = false;
    for (const item of list) {
      if (!item.active || !item.nextSendAt) continue;
      if (new Date(item.nextSendAt).getTime() > now) continue;
      changed = true;
      let subs = readJSON(PUSH_SUBS_FILE);
      const segment = Array.isArray(item.phones) && item.phones.length ? new Set(item.phones) : null;
      const targets = segment ? subs.filter(s => segment.has(s.phone)) : subs;
      if (targets.length) {
        const payload = {
          title: item.title || cfg.name || 'Shogatsu',
          body: item.message,
          url: item.url || '/',
          icon: '/icon-192.png',
          image: item.image || undefined,
          sound: 'oriental',
          tag: 'shogatsu-agendada-' + item.id
        };
        const expired = [];
        for (const sub of targets) {
          const r = await webpush.sendWebPush(sub, payload, cfg.vapid, cfg.vapid.subject);
          if (r.expired) expired.push(sub.endpoint);
        }
        if (expired.length) writeJSON(PUSH_SUBS_FILE, subs.filter(s => !expired.includes(s.endpoint)));
      }
      item.lastSentAt = new Date().toISOString();
      item.sentCount = (item.sentCount || 0) + 1;
      if (item.recurrence && item.recurrence !== 'none') {
        item.nextSendAt = computeNextSend(item.nextSendAt, item.recurrence, item.intervalMinutes);
      } else {
        item.active = false;
      }
    }
    if (changed) writeJSON(SCHEDULED_PUSH_FILE, list);
  } catch (e) { console.error('⚠️  Checador de push agendado:', e.message); }
}
setInterval(checkScheduledPush, 60 * 1000);

restoreFromSupabase().finally(() => {
  loadSessionsFromDisk(); // v60: depois de restaurar do Supabase (se configurado), carrega sessões válidas pra memória
  restoreUploadsFromSupabase().finally(() => {
    server.listen(PORT, () => {
      console.log(`🍣 Shogatsu rodando em http://localhost:${PORT}`);
      console.log(`   Painel da cozinha: http://localhost:${PORT}/painel.html`);
      if (!process.env.UPLOADS_DIR && !SUPABASE_URL) {
        console.log('⚠️  ATENÇÃO: UPLOADS_DIR não configurado e Supabase não configurado — fotos enviadas podem se perder no próximo deploy. Configure um Disco Persistente (UPLOADS_DIR) ou SUPABASE_URL/SUPABASE_SERVICE_KEY. Veja o README.md.');
      }
    });
  });
});
