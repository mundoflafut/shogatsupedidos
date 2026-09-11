// ═══════════════════════════════════════════════════════════
// SHOGATSU · Agente Local de Impressão Automática
// ═══════════════════════════════════════════════════════════
// Roda num computador DENTRO da loja, ligado (por rede ou USB) na impressora térmica.
// Fica escutando o servidor em tempo real e imprime sozinho assim que um pedido novo chega —
// sem abrir navegador, sem diálogo de impressão, sem PDF. Se a impressora falhar, registra
// o erro no arquivo de log e continua rodando (nunca trava o restante do sistema).
//
// Por quê isso roda separado do site? O site fica hospedado num servidor na nuvem (Render),
// que não tem nenhuma impressora física ligada nele — fisicamente impossível imprimir "no
// servidor" de verdade. Esse agente é a forma real de ter impressão 100% automática: ele é
// só mais um "cliente" do sistema (como o navegador do painel), só que ao invés de mostrar
// pedido na tela, manda direto pra impressora.
//
// Como usar:
//   1. npm install          (só nesta pasta print-agent/)
//   2. copie config.example.json pra config.json e preencha com seus dados
//   3. node print-agent.js
//   4. (opcional, recomendado) configure pra iniciar sozinho com o Windows/Linux — veja o README.md
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'print-agent.log');
const WINPRINT_HELPER_PATH = path.join(__dirname, 'winprint-helper.ps1');
const TEST_MODE = process.env.TEST_MODE === '1';
const PENDING_POLL_MS = 15000; // não manda pra impressora de verdade, só mostra no log/console

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ Não encontrei config.json. Copie config.example.json pra config.json e preencha os dados antes de rodar.');
  process.exit(1);
}
// v100: strip do BOM (﻿) no início do arquivo — o Bloco de Notas do Windows às vezes grava
// esse caracter invisível ao salvar "UTF-8" (só o "UTF-8" puro não grava; o BOM some se salvar
// como "UTF-8 (sem BOM)"), e isso quebrava JSON.parse com "Unexpected token" mesmo com o JSON
// em si perfeitamente válido. Editar config.json num editor comum de texto é o fluxo normal
// pra configurar impressoras/stationId — não faz sentido travar o agente por causa disso.
let rawConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
if (rawConfig.charCodeAt(0) === 0xFEFF) rawConfig = rawConfig.slice(1);
let cfg;
try {
  cfg = JSON.parse(rawConfig);
} catch (e) {
  console.error('❌ config.json tem um erro de formatação (JSON inválido): ' + e.message);
  console.error('   Confira se não sobrou/faltou vírgula, aspas ou chave { } ao editar o arquivo.');
  process.exit(1);
}

function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, msg + '\n'); } catch (e) { /* nunca deixa o log derrubar o agente */ }
}

// ─── Impressoras (v55: agora suporta MAIS DE UMA impressora no mesmo agente/computador —
// ex: uma na USB do balcão + uma de rede na cozinha + outra de rede no sushibar. Cada
// impressora cuida das vias (estações) que você atribuir a ela; o agente descobre sozinho
// pra qual impressora mandar cada via na hora de imprimir. Isso substitui a necessidade de
// rodar um agente por computador quando a loja tem mais de uma impressora — agora dá pra
// centralizar as três (USB + rede 1 + rede 2) num único agente, num único computador, desde
// que ele enxergue a rede das impressoras de rede e tenha a USB ligada nele.
//
// Formato novo do config.json:
//   "printers": [
//     { "label": "Caixa (USB)",      "type": "epson", "interface": "printer:NOME", "width": 42, "stations": ["caixa"] },
//     { "label": "Cozinha (Rede 1)", "type": "epson", "interface": "tcp://192.168.1.51:9100", "width": 48, "stations": ["cozinha"] },
//     { "label": "Sushibar (Rede 2)","type": "epson", "interface": "tcp://192.168.1.52:9100", "width": 48, "stations": ["sushibar","bar"] }
//   ]
//
// Continua funcionando com o config.json antigo (uma impressora só, campos soltos
// printerType/printerInterface/printerWidth/stations) — é convertido sozinho pro formato
// novo aqui embaixo, sem quebrar quem já tinha configurado do jeito anterior.
function loadPrinters() {
  if (Array.isArray(cfg.printers) && cfg.printers.length) {
    return cfg.printers.map(p => ({
      label: p.label || p.stations?.join(', ') || 'Impressora',
      type: p.type === 'star' ? PrinterTypes.STAR : PrinterTypes.EPSON,
      interface: p.interface,
      // v126 — BUG CORRIGIDO ("ajuste pra caber na bobina 80mm bematech"): o padrão de
      // fábrica era 42 colunas — nem o valor certo pra 58mm (32) nem pra 80mm (48), então
      // QUALQUER impressora nova (58mm ou 80mm) que ninguém tivesse configurado explicitamente
      // com "width" no config.json saía com colunas erradas pros dois casos. Ficha técnica de
      // 80mm Bematech em modo ESC/POS (fonte A, padrão de fábrica) é 48 colunas — mesmo valor
      // já usado no lado do servidor pra impressão direta (ver printCols() em server.js) —
      // então 48 vira o novo padrão daqui também, mantendo os dois lados consistentes. Quem
      // usa 58mm continua podendo sobrescrever com "width": 32 no config.json normalmente.
      width: p.width || 48,
      stations: Array.isArray(p.stations) && p.stations.length ? p.stations : ['caixa']
    }));
  }
  // formato antigo (uma impressora só) — mantém compatibilidade
  return [{
    label: 'Impressora principal',
    type: cfg.printerType === 'star' ? PrinterTypes.STAR : PrinterTypes.EPSON,
    interface: cfg.printerInterface,
    width: cfg.printerWidth || 48, // v126 — mesmo ajuste acima (era 42, virou 48 = padrão 80mm)
    stations: Array.isArray(cfg.stations) && cfg.stations.length ? cfg.stations : ['caixa']
  }];
}
const PRINTERS = loadPrinters();
// v82: identificador único gerado a cada inicialização do agente — só serve pra distinguir
// "sinais de vida" (announce) de instâncias diferentes na tela do painel; não precisa persistir
// entre reinícios, um novo é gerado toda vez e o anterior simplesmente expira sozinho (90s) do
// lado do servidor.
const AGENT_ID = crypto.randomBytes(6).toString('hex');

// v90: "stationId" opcional no config.json — identifica A QUAL computador/estação este Agente
// pertence, pra ser cruzado com o stationId do Painel (localStorage, gerado no navegador —
// ver getOrCreateStationId() em painel.html) daquele MESMO computador. Quando configurado, o
// Agente só imprime enquanto o servidor confirmar que esse é o stationId da ESTAÇÃO ATIVA
// agora (ver isAuthorizedToPrint() abaixo) — evita 2 computadores (ex.: PC principal + PC
// reserva, cada um com seu próprio Painel+Agente) imprimindo o mesmo pedido ao mesmo tempo.
// Pra configurar: abra o Painel neste MESMO computador → Configurações → Central de Impressão
// → copie o código mostrado em "🖥️ Estação deste computador" e cole aqui em "stationId".
// Se deixar em branco (padrão), o Agente imprime exatamente como sempre imprimiu — sem
// nenhuma trava nova — pra não quebrar quem já está usando o sistema hoje com um Agente só.
const STATION_ID = cfg.stationId ? String(cfg.stationId).trim() || null : null;

function printerForStation(station) {
  return PRINTERS.find(p => p.stations.includes(station)) || null;
}

// v83.2 — CONTORNO PRA IMPRESSORA USB NO WINDOWS ("No driver set!" / npm 'printer' quebrado):
// o pacote nativo 'printer' (usado pelo node-thermal-printer pra falar com impressoras
// instaladas como "printer:NOME" no Windows) está abandonado e não compila mais em
// versões novas do Node sem Python + Visual Studio Build Tools instalados. Em vez de
// depender dele, pra impressoras "printer:NOME" a gente:
//   1. monta o ThermalPrinter com uma interface "tcp://" falsa, só pra ele aceitar
//      construir sem precisar de nenhum driver nativo (nunca chega a conectar nela de
//      verdade — não chamamos .execute() nesse caso);
//   2. usa .getBuffer() pra pegar os bytes ESC/POS já prontos, sem enviar a lugar nenhum;
//   3. manda esses bytes direto pra fila de impressão do Windows (RAW) via winspool.drv,
//      chamando um script PowerShell auxiliar (winprint-helper.ps1) — mesmo mecanismo que
//      o Bloco de Notas usa por baixo dos panos, sem precisar de nenhum pacote extra.
function isWindowsNamedPrinter(printerCfg) {
  return process.platform === 'win32' && /^printer:/i.test(printerCfg.interface || '');
}

function windowsPrinterName(printerCfg) {
  return printerCfg.interface.replace(/^printer:/i, '');
}

function sendRawBufferToWindowsPrinter(printerName, buffer) {
  if (!fs.existsSync(WINPRINT_HELPER_PATH)) {
    throw new Error(`winprint-helper.ps1 não encontrado em ${WINPRINT_HELPER_PATH} (deveria estar do lado do print-agent.js).`);
  }
  const tmpFile = path.join(os.tmpdir(), `shogatsu-print-${crypto.randomBytes(4).toString('hex')}.bin`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', WINPRINT_HELPER_PATH,
      '-PrinterName', printerName,
      '-FilePath', tmpFile
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* arquivo temporário, sem problema se sobrar */ }
  }
}

function buildPrinter(printerCfg) {
  if (TEST_MODE) return null; // modo teste não precisa de impressora de verdade
  return new ThermalPrinter({
    type: printerCfg.type,
    // v83.2: pra impressora "printer:NOME" (USB/instalada no Windows), usamos uma interface
    // tcp:// de mentirinha só pra passar pela validação do construtor — os bytes nunca são
    // enviados por ela de verdade (ver sendRawBufferToWindowsPrinter acima). Pra impressora
    // de rede de verdade (tcp://IP:porta) ou Linux (/dev/...), continua igual a antes.
    interface: isWindowsNamedPrinter(printerCfg) ? 'tcp://127.0.0.1:9100' : printerCfg.interface,
    width: printerCfg.width,
    // v84.1 — sem isto, qualquer texto com acento (á, ã, ç, é...) quebrava a impressão com
    // "Encoding not recognized: 'undefined'", pois a biblioteca não sabia qual codificação
    // usar pra converter o texto pros bytes que a impressora entende. PC860_PORTUGUESE cobre
    // os acentos do português. Dá pra sobrescrever por impressora com "characterSet" no
    // config.json, se um dia precisar de outra (ex.: impressora antiga que só aceite outra).
    characterSet: printerCfg.characterSet || 'PC860_PORTUGUESE',
    removeSpecialCharacters: false,
    options: { timeout: 5000 }
  });
}

const money = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');
// v84 — mesma correção do server.js/painel.html ("pagamento deve aparecer como pagamento na
// entrega"): PIX é pago antes, mas dinheiro/crédito/débito num pedido delivery são cobrados
// só na entrega — a via do caixa impressa aqui (agente local) precisa deixar isso claro pro
// motoboy/caixa, não só mostrar a forma escolhida.
const PAY_METHOD_LABELS = { pix: 'PIX', credito: 'CARTAO DE CREDITO', debito: 'CARTAO DE DEBITO', dinheiro: 'DINHEIRO' };
function payMethodTicketLabel(order) {
  const base = PAY_METHOD_LABELS[order.payMethod] || (order.payMethod || '-').toUpperCase();
  if (!order.payMethod || order.payMethod === 'pix') return base;
  return base + (order.mode === 'delivery' ? ' (PAGAMENTO NA ENTREGA)' : ' (PAGAMENTO NA RETIRADA)');
}
// v55: quais vias esse agente é responsável por imprimir — agora é a UNIÃO das vias de
// TODAS as impressoras configuradas acima (antes era uma lista solta em cfg.stations).
const MY_STATIONS = [...new Set(PRINTERS.flatMap(p => p.stations))];
// v129 — NOVO: rótulos das duas vias que faltavam aqui (delivery/expedição já existem como
// estação padrão do sistema desde a v46, mas essa lista hardcoded no Agente nunca foi
// atualizada — sem entrada aqui, essas duas vias apareciam sem nome bonito nos logs/ticket).
const STATION_LABELS = { caixa: 'Caixa', cozinha: 'Cozinha', sushibar: 'Sushibar', bar: 'Bar', delivery: 'Delivery', expedicao: 'Expedição' };
// v129 — NOVO ("via do motoboy/expedição deve focar em cliente/endereço/pagamento, não na
// lista de itens"): o Agente Local não tem acesso ao cfg.stations[x].kind do servidor (ele só
// enxerga config.json PRÓPRIO, de impressora — ver loadPrinters() acima), então usa a mesma
// convenção de nome fixo que o servidor usa como padrão de fábrica (ver DEFAULT_CFG.stations
// em server.js). Cobre o caso de longe mais comum (as duas vias de despacho padrão do
// sistema); uma via de despacho CUSTOMIZADA com outro nome continuaria saindo como produção
// aqui — mesma limitação que STATION_LABELS acima já tinha pra nomes fora da lista.
const DISPATCH_STATIONS = ['delivery', 'expedicao'];

// v92 — mesma correção de tamanho de fonte feita no server.js (impressora de rede/USB direta),
// agora espelhada aqui pro Agente Local (que usa node-thermal-printer): antes o tamanho
// configurado em Configurações → Impressão simplesmente não tinha efeito nenhum aqui — só o
// cabeçalho (nome da loja) tinha uma altura fixa dobrada, sempre, independente da configuração.
function tamanhoImpressaoTermica(printSize) {
  const s = Number(printSize) || 14;
  if (s >= 26) return { h: 3, w: 1 };
  if (s >= 22) return { h: 2, w: 0 };
  if (s >= 18) return { h: 1, w: 0 };
  return { h: 0, w: 0 };
}

// v46: layout igual ao das outras vias do sistema (painel.html/server.js) — cabeçalho
// centralizado, blocos com título, "TOTAL" em destaque na via do caixa, e "ITENS
// DA <SETOR>" + espaço de observações nas vias de produção (cozinha/sushibar/bar).
function printStationTicket(printer, order, station, storeName) {
  const isCaixa = station === 'caixa';
  const isDispatch = !isCaixa && DISPATCH_STATIONS.includes(station);
  const items = (isCaixa || isDispatch) ? (order.items || []) : (order.items || []).filter(i => (i.stations || []).includes(station));
  // v129: despacho só imprime pra pedido DELIVERY (retirada não tem motoboy pra avisar) —
  // não depende de item nenhum ter essa via marcada (ninguém marca comida como "via delivery").
  if (isDispatch && order.mode !== 'delivery') return false;
  if (!isDispatch && !items.length) return false; // essa via não tem nada desse pedido — não desperdiça papel

  const tam = tamanhoImpressaoTermica(order._printFontSize);
  // v131 — NOVO VISUAL DO COMPROVANTE (só formatação — nenhuma lógica de fila, claim,
  // anti-duplicação, corte, bipe ou comunicação com a impressora foi tocada aqui): cabeçalho
  // emoldurado por linha dupla em cima E embaixo, e "PEDIDO #" vira o elemento mais destacado
  // do ticket inteiro (pedido explícito do novo layout "premium minimalista").
  printer.alignCenter();
  printer.drawLine('=');
  printer.bold(true); printer.setTextDoubleHeight();
  printer.println((storeName || 'SHOGATSU').toUpperCase());
  printer.setTextNormal(); printer.bold(false);
  // v133 — BUG CORRIGIDO ("cabeçalho deve ter apenas Shogatsu Culinária Oriental"): a linha
  // fixa "CULINARIA ORIENTAL" abaixo do nome da loja ficava redundante quando o nome já
  // configurado (storeName) é algo como "Shogatsu Culinária Oriental" — mesma correção feita
  // no server.js. Cabeçalho mostra só o nome da loja, uma vez.
  printer.drawLine('=');
  printer.newLine();
  printer.bold(true); printer.setTextSize(tam.h, Math.min(tam.w + 1, 5));
  printer.println(order.ticketNumber ? `PEDIDO Nº ${order.ticketNumber}` : `PEDIDO #${order.id}`);
  printer.setTextSize(tam.h, tam.w); printer.bold(false);
  printer.newLine();
  printer.setTextSize(tam.h, tam.w); // a partir daqui, o corpo do ticket já respeita o tamanho configurado

  if (isCaixa) {
    // v131 — NOVO VISUAL (mesmo dado, só reorganizado por seção: DATA/HORA/TIPO, ITENS,
    // OBSERVAÇÃO, CLIENTE/TELEFONE/ENDEREÇO, PAGAMENTO+TOTAL — igual ao layout novo do
    // server.js, pra ficar igual não importa qual caminho de impressão a loja usa).
    // v131 — BUG CORRIGIDO ("tempo de entrega deve ser o que está definido no sistema"): o
    // Agente Local nunca mostrava a previsão de entrega/retirada no comprovante — o valor
    // calculado a partir do que está configurado em Configurações (cfg.time/cfg.timeRetirada)
    // só chegava pro navegador e pra impressão direta do servidor, nunca pro Agente Local. O
    // servidor agora manda esse valor pronto (order._deliveryWindow, calculado com a MESMA
    // configuração) tanto no pedido novo em tempo real quanto na fila de recuperação.
    printer.alignLeft();
    printer.drawLine();
    printer.println('DATA: ' + new Date(order.createdAt).toLocaleDateString('pt-BR'));
    printer.println('HORA: ' + new Date(order.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    printer.println('TIPO: ' + (order.mode === 'delivery' ? 'DELIVERY' : 'RETIRADA'));
    printer.drawLine();
    printer.newLine();
    items.forEach(it => {
      printer.print(`${it.qty}x  `);
      printer.bold(true); printer.setTextSize(tam.h, Math.min(tam.w + 1, 5));
      printer.println(it.name);
      printer.bold(false); printer.setTextSize(tam.h, tam.w);
    });
    printer.drawLine();
    if (order.obs) {
      printer.newLine();
      printer.bold(true); printer.println('OBSERVACAO'); printer.bold(false);
      printer.println(order.obs);
      printer.drawLine();
    }
    if (order.scheduledFor) { printer.println('Agendado: ' + new Date(order.scheduledFor).toLocaleString('pt-BR')); printer.drawLine(); }
    printer.newLine();
    printer.bold(true); printer.println('CLIENTE'); printer.bold(false);
    printer.println(order.name || '-');
    printer.newLine();
    printer.bold(true); printer.println('TELEFONE'); printer.bold(false);
    if (order.phone) printer.println(order.phone);
    if (order.mode === 'delivery' && order.address) {
      printer.newLine();
      printer.bold(true); printer.println('ENDERECO'); printer.bold(false);
      printer.println(order.address);
    }
    printer.println((order.mode === 'delivery' ? 'Previsao: ' : 'Previsao retirada: ') + (order._deliveryWindow || '—'));
    printer.drawLine();
    printer.newLine();
    printer.bold(true); printer.println('PAGAMENTO'); printer.bold(false);
    printer.println(`${payMethodTicketLabel(order)}${order.paid ? ' (PAGO)' : ''}${order.troco ? ' (troco para ' + order.troco + ')' : ''}`);
    printer.newLine();
    printer.leftRight('Subtotal', money(order.subtotal));
    printer.leftRight('Entrega', money(order.fee));
    if (order.discount > 0 || order.couponCode) printer.leftRight(`Cupom ${order.couponCode || ''}`, '-' + money(order.discount || 0));
    printer.newLine();
    printer.bold(true); printer.println('TOTAL'); printer.bold(false);
    printer.bold(true); printer.setTextSize(tam.h, Math.min(tam.w + 1, 5));
    printer.println(money(order.total));
    printer.setTextSize(tam.h, tam.w); printer.bold(false);
    printer.alignCenter();
    printer.drawLine('=');
    printer.newLine();
    // v133 — BUG CORRIGIDO ("rodapé deve ter apenas Obrigado pela Preferência"): antes
    // repetia "OBRIGADO!" + o nome da loja de novo (redundante). Volta pra uma linha só.
    printer.bold(true); printer.println('OBRIGADO PELA PREFERENCIA!'); printer.bold(false);
    printer.drawLine('=');
    printer.alignLeft();
  } else if (isDispatch) {
    // v129 — NOVO ("via do motoboy/expedição deve focar em cliente/endereço/pagamento, não
    // na lista de itens como cozinha/sushibar"): mesmo bloco de dados de entrega do Caixa,
    // sem lista de itens — quem sai pra entregar só precisa saber pra onde ir e quanto cobrar.
    printer.println((STATION_LABELS[station] || station).toUpperCase());
    printer.println('VIA DE DESPACHO');
    printer.alignLeft();
    printer.println(`Ref.: #${String(order.id).slice(-11).toUpperCase()}`);
    printer.drawLine();
    printer.bold(true); printer.println('CLIENTE'); printer.bold(false);
    printer.drawLine();
    printer.println(order.name || '-');
    if (order.phone) printer.println('Tel: ' + order.phone);
    printer.drawLine();
    printer.bold(true); printer.println('ENDERECO'); printer.bold(false);
    printer.drawLine();
    printer.println(order.address || '-');
    printer.drawLine();
    printer.bold(true); printer.println('PAGAMENTO'); printer.bold(false);
    printer.drawLine();
    printer.println(payMethodTicketLabel(order));
    printer.leftRight('Total:', money(order.total));
    if (order.troco) printer.leftRight('Troco para:', String(order.troco));
    printer.drawLine();
    printer.leftRight('Taxa de entrega:', money(order.fee));
    printer.leftRight('Motoboy:', order.courierName || 'A definir');
    // v131 — BUG CORRIGIDO ("tempo de entrega deve ser o que está definido no sistema"):
    // igual à via do Caixa acima, agora usa order._deliveryWindow (calculado pelo servidor a
    // partir de cfg.time/cfg.timeRetirada) em vez de não mostrar nada.
    printer.leftRight('Previsao:', order._deliveryWindow || '—');
    if (order.obs) { printer.drawLine(); printer.bold(true); printer.println('OBSERVACAO'); printer.bold(false); printer.println(order.obs); }
  } else {
    printer.println((STATION_LABELS[station] || station).toUpperCase());
    printer.println('VIA DE PRODUCAO');
    printer.alignLeft();
    printer.println(`Ref.: #${String(order.id).slice(-11).toUpperCase()}`);
    printer.println(order.mode === 'delivery' ? 'DELIVERY' : 'RETIRADA');
    printer.drawLine();
    printer.bold(true); printer.println('ITENS DA ' + (STATION_LABELS[station] || station).toUpperCase()); printer.bold(false);
    printer.drawLine();
    items.forEach(it => {
      // v128 — NOVO ("nome do item deve ser maior e em negrito na comanda da cozinha e
      // sushibar pra melhor visualização"): só o NOME do item vem com largura +1 (relativo
      // ao tamanho já configurado em Fonte de Impressão, "tam.w" acima) + negrito —
      // setTextDoubleWidth()/setTextNormal() reiniciariam o tamanho pro padrão de fábrica da
      // impressora, perdendo o "tam.h/tam.w" configurado pra todo o resto do ticket; por
      // isso usa setTextSize(tam.h, tam.w+1) e depois volta pro tam.h/tam.w original — nunca
      // pro zero. Largura tem teto (min 5) pra não sair um nome gigante ilegível.
      printer.print('* ' + it.qty + 'x ');
      printer.bold(true); printer.setTextSize(tam.h, Math.min(tam.w + 1, 5));
      printer.println(it.name);
      printer.bold(false); printer.setTextSize(tam.h, tam.w);
    });
    printer.drawLine();
    printer.println('Observacoes:');
    if (order.obs) printer.println(order.obs);
    else { printer.println('_______________________________'); printer.println('_______________________________'); }
  }
  printer.newLine();
  printer.cut();
  // v126 — NOVO ("fazer um bip duplo ao imprimir"): mesmo comando de campainha dupla usado
  // no lado do servidor (ver ESC.beep em server.js) — printer.beep(2,2) apita 2 vezes.
  // Impressora sem campainha (ou desligada no hardware) simplesmente ignora, sem erro.
  printer.beep(2, 2);
  return true;
}

// v54: extraído de dentro de printOrder() pra poder imprimir UMA via específica sob
// demanda (reimpressão manual pedida do painel, de celular ou PC — ver evento
// "print-order" mais abaixo), sem precisar reimprimir todas as vias desse agente de novo.
// v93 — via de RESERVA DE MESA. Usa a impressora configurada pra via "caixa" (é quem
// normalmente atende o cliente que reservou). Mesmas travas de segurança do pedido novo
// (isAuthorizedToPrint) — não imprime se este computador não estiver autorizado agora.
function printReservationTicket(printer, reservation, storeName) {
  const tam = tamanhoImpressaoTermica(reservation._printFontSize);
  printer.alignCenter();
  printer.bold(true); printer.setTextDoubleHeight();
  printer.println((storeName || 'SHOGATSU').toUpperCase());
  printer.setTextNormal(); printer.bold(false);
  // v133 — mesma correção do cabeçalho de pedido acima (nome da loja repetido).
  printer.drawLine();
  printer.setTextSize(tam.h, tam.w);
  printer.bold(true); printer.println('RESERVA DE MESA'); printer.bold(false);
  printer.alignLeft();
  printer.println('Ref.: ' + reservation.id);
  printer.println('Status: ' + (reservation.status === 'confirmada' ? 'CONFIRMADA' : 'PENDENTE DE CONFIRMACAO'));
  printer.drawLine();
  printer.bold(true); printer.println('CLIENTE'); printer.bold(false);
  printer.drawLine();
  printer.println(reservation.name);
  printer.println('Tel: ' + reservation.phone);
  printer.drawLine();
  printer.bold(true); printer.println('DETALHES'); printer.bold(false);
  printer.drawLine();
  const dataFmt = reservation.date ? new Date(reservation.date + 'T00:00').toLocaleDateString('pt-BR') : '';
  printer.println('Data: ' + dataFmt);
  printer.println('Hora: ' + reservation.time);
  printer.println('Pessoas: ' + reservation.people);
  if (reservation.notes) { printer.drawLine(); printer.println('Obs: ' + reservation.notes); }
  printer.setTextNormal();
  printer.alignCenter();
  printer.println('Reservado em ' + new Date(reservation.createdAt).toLocaleString('pt-BR'));
}
async function printReservation(reservation) {
  // v106 — REMOVIDA a checagem isAuthorizedToPrint() daqui: ela dependia de algum PAINEL estar
  // aberto/conectado em QUALQUER computador do sistema pra autorizar a impressão — em uma loja
  // com várias estações/computadores rodando ao mesmo tempo, isso bloqueava reservas sem motivo
  // real. A proteção contra duplicidade (2 Agentes cobrindo "caixa" ao mesmo tempo, ambos
  // recebendo o mesmo evento automático) agora é feita de forma correta logo abaixo, com
  // POST /api/print-agent/claim (idempotente, por reserva, gravado em disco — sobrevive a F5,
  // reconexão e restart do servidor/Agent).
  const claimed = await claimPrintJob({ kind: 'reservation', id: reservation.id });
  if (!claimed) {
    log(`⏭️  Reserva ${reservation.id} já foi reclamada/impressa por outro Agente antes — pulando (evita duplicidade).`);
    return;
  }
  const printerCfg = printerForStation('caixa');
  if (!printerCfg) { await releasePrintJob({kind:'reservation',id:reservation.id,station:'caixa'}); log(`⚠️  Nenhuma impressora configurada pra via "caixa" — reserva ${reservation.id} não impressa.`); return; }
  // v126 — AUDITORIA — BUG CORRIGIDO ("aviso de já impressa" numa reserva que nunca imprimiu
  // de verdade): em TEST_MODE, esta função reclamava a trava (claimPrintJob, linha acima) e
  // então retornava aqui embaixo SEM chamar completeReservationPrint() nem releasePrintJob() —
  // a trava ficava presa em status "printing" por até 90s (o "lease" do claim), e se alguém
  // desligasse o Modo Teste e reiniciasse o Agente nesse intervalo pra imprimir de verdade, a
  // segunda tentativa também podia esbarrar na trava ainda não liberada. Pior: se o Modo Teste
  // ficasse ligado por engano com autoAcceptReservations também ligado, a reserva real nunca
  // seria marcada como concluída nem liberada pra reimpressão manual soar corretamente no
  // painel. Como aqui não existe impressora física nenhuma envolvida (é só simulação), a trava
  // é liberada na mesma hora — nunca fica presa "achando" que já imprimiu algo que não imprimiu.
  if (TEST_MODE) { log(`🧪 [TEST_MODE] Imprimiria agora a reserva ${reservation.id} (impressora: ${printerCfg.label})`); await releasePrintJob({kind:'reservation',id:reservation.id,station:'caixa'}); return; }
  const printer = buildPrinter(printerCfg);
  const isWinPrinter = isWindowsNamedPrinter(printerCfg);
  try {
    if (!isWinPrinter) {
      const connected = await printer.isPrinterConnected();
      if (!connected) throw new Error(`Impressora "${printerCfg.label}" não respondeu.`);
    }
    printReservationTicket(printer, reservation, cfg.storeName);
    printer.newLine(); printer.cut();
    printer.beep(2, 2); // v126 — bipe duplo (mesma ideia da via de pedido acima)
    if (isWinPrinter) sendRawBufferToWindowsPrinter(windowsPrinterName(printerCfg), printer.getBuffer());
    else await printer.execute();
    await completeReservationPrint(reservation.id);
    log(`✅ Reserva ${reservation.id} impressa com sucesso na impressora "${printerCfg.label}".`);
  } catch (err) {
    await releasePrintJob({kind:'reservation',id:reservation.id,station:'caixa'});
    log(`❌ Falha ao imprimir reserva ${reservation.id} (impressora "${printerCfg.label}"): ${err.message}`);
  }
}


// de acordo com qual delas cuida dessa via — cada comanda sai na impressora certa, no
// local certo, mesmo com várias impressoras diferentes no mesmo agente.
// v60: avisa o servidor se a impressão dessa via deu certo ou não — é isso que faz o aviso
// "🖨 Impresso!"/"⚠️ Falhou" aparecer de volta em quem clicou em Imprimir, mesmo de outro
// aparelho (celular usado como controle remoto pro PC ligado na impressora). Se essa chamada
// falhar (sem internet, servidor fora do ar), o agente já registrou tudo no log local — não
// tenta de novo pra não atrasar a próxima impressão.
async function reportPrintResult(order, station, ok, error) {
  try {
    await request('POST', `${cfg.serverUrl}/api/print-ack`, { orderId: order.id, station, ok, error: error || null, agentId: AGENT_ID });
  } catch (e) { log(`⚠️  Não consegui avisar o servidor sobre o resultado da via "${station}" (${ok ? 'sucesso' : 'falha'}): ${e.message}`); }
}

// v106 — NOVO: reclama (de forma idempotente, persistida em disco no servidor) o direito de
// imprimir automaticamente UM pedido+via (ou UMA reserva) específico, ANTES de mandar pra
// impressora física. Substitui a antiga trava isAuthorizedToPrint()/"Estação Ativa" (que
// dependia de um painel aberto em algum computador e bloqueava estações/dispositivos
// diferentes sem necessidade — ver server.js). Continua garantindo o que a trava antiga também
// tentava garantir (2 Agentes cobrindo a MESMA via não imprimem o mesmo trabalho 2x), só que
// isolado por pedido+via — não afeta outras vias/estações, e não exige NENHUM painel aberto em
// lugar nenhum, o que também corrige uma limitação real: antes, com todos os painéis fechados,
// a impressão automática simplesmente nunca acontecia, mesmo com o Agente rodando sozinho.
// Se o servidor não responder (sem internet, servidor fora do ar), assume "reclamado" (imprime
// mesmo assim) — entre imprimir uma via a mais por engano e PERDER um pedido de verdade, perder
// um pedido é muito pior num restaurante; fica tudo registrado no log local de qualquer forma.
async function claimPrintJob({ kind, id, station }) {
  try {
    const r = await request('POST', `${cfg.serverUrl}/api/print-agent/claim?token=${encodeURIComponent(token)}`, { kind, id, station, agentId: AGENT_ID });
    if (r.status === 200 && r.data) return !!r.data.claimed;
    return true; // resposta inesperada do servidor — não bloqueia a impressão por causa disso
  } catch (e) {
    log(`⚠️  Não consegui confirmar com o servidor se ${kind === 'reservation' ? 'a reserva' : 'o pedido'} ${id} já foi impresso — imprimindo mesmo assim (prioridade: nunca perder um pedido).`);
    return true;
  }
}

async function releasePrintJob({kind,id,station}){try{await request('POST',`${cfg.serverUrl}/api/print-agent/release?token=${encodeURIComponent(token)}`,{kind,id,station,agentId:AGENT_ID});}catch(e){log(`⚠️ Não consegui liberar a trava de impressão de ${kind==='reservation'?'reserva':'pedido'} ${id}: ${e.message}`);}}
async function completeReservationPrint(id){try{await request('POST',`${cfg.serverUrl}/api/print-agent/complete?token=${encodeURIComponent(token)}`,{kind:'reservation',id});}catch(e){log(`⚠️ Não consegui confirmar impressão da reserva ${id}: ${e.message}`);}}

async function printSingleStation(order, station) {
  const printerCfg = printerForStation(station);
  if (!printerCfg) { const msg = `Nenhuma impressora configurada pra via "${station}"`; log(`⚠️  ${msg} — nada impresso (confira "printers" no config.json).`); return { ok:false, error: msg }; }
  if (TEST_MODE) {
    log(`🧪 [TEST_MODE] Imprimiria agora o pedido ${order.id} na via: ${station} (impressora: ${printerCfg.label})`);
    return { ok:true };
  }
  const printer = buildPrinter(printerCfg);
  const isWinPrinter = isWindowsNamedPrinter(printerCfg);
  try {
    if (!isWinPrinter) {
      // Impressora de rede/serial de verdade — mantém a checagem original.
      const connected = await printer.isPrinterConnected();
      if (!connected) throw new Error(`Impressora "${printerCfg.label}" não respondeu (verifique se está ligada e na mesma rede/USB).`);
    }
    const hadItems = printStationTicket(printer, order, station, cfg.storeName);
    if (!hadItems) { log(`ℹ️  Pedido ${order.id} — via "${station}" sem itens dessa via, nada impresso.`); return { ok:true, skipped:true }; }
    if (isWinPrinter) {
      // v83.2: pega os bytes ESC/POS prontos e manda pra fila de impressão do Windows,
      // sem depender do pacote nativo 'printer' (ver buildPrinter acima pra explicação).
      const buffer = printer.getBuffer();
      sendRawBufferToWindowsPrinter(windowsPrinterName(printerCfg), buffer);
    } else {
      await printer.execute();
    }
    log(`✅ Pedido ${order.id} — via "${station}" impressa com sucesso na impressora "${printerCfg.label}".`);
    return { ok:true };
  } catch (err) {
    log(`❌ Falha ao imprimir pedido ${order.id} (via "${station}", impressora "${printerCfg.label}"): ${err.message}`);
    return { ok:false, error: err.message };
  }
}

// v55: imprime TODAS as vias desse pedido de uma vez, cada uma na sua impressora — é o que
// dá o efeito de "um clique só (ou automático) manda tudo pro lugar certo": a via do caixa
// sai na impressora do caixa, a da cozinha na da cozinha, etc., mesmo sendo impressoras
// físicas diferentes (USB + rede 1 + rede 2), tudo dentro da mesma chamada.
// v82 — BUG CORRIGIDO ("não dá pra saber por que a impressão automática falhou, sem abrir o
// log no computador da loja"): até aqui, só a impressão SOB DEMANDA (clique manual em
// Imprimir/Reimprimir, via printOnDemand) avisava o servidor do resultado — a impressão
// AUTOMÁTICA (disparada sozinha ao chegar um pedido novo, que é o caminho usado 99% do tempo)
// nunca chamava reportPrintResult(), então uma falha aqui (impressora desligada, IP errado,
// papel preso) só aparecia no print-agent.log local, invisível pro admin no painel. Agora
// avisa o servidor em AMBOS os casos — as falhas passam a aparecer em Configurações → 🖨
// Central de Impressão → "Últimas falhas de impressão".
async function printOrder(order) {
  if (TEST_MODE) {
    log(`🧪 [TEST_MODE] Imprimiria agora o pedido ${order.id} nas vias: ${MY_STATIONS.join(', ')}`);
    return true;
  }
  // v92 — BUG CORRIGIDO ("não deve imprimir se o botão de aceite automático estiver
  // desligado"): a impressão automática nasceu pensada pra andar junto do aceite automático
  // (ver v55 no server.js) — sem isso ligado, o pedido fica pendente aguardando alguém aceitar
  // manualmente, e imprimir sozinho gastava papel de pedidos que podiam nem ser aceitos.
  if (!order._autoAcceptOn) {
    log(`⏸️  Pedido ${order.id} recebido, mas impressão automática pulada — "Aceite automático" está desligado (Configurações → Pedidos). Use o botão "🖨 Imprimir" no painel se quiser essa via na hora.`);
    return false;
  }
  let anyPrinted = false;
  for (const station of MY_STATIONS) {
    // v106 — cada via é reclamada (claim) individualmente, por pedido+via — ver
    // claimPrintJob() acima. Isso é o que garante que 2 Agentes cobrindo a MESMA via não
    // imprimem o mesmo pedido 2x, sem depender de nenhum painel estar aberto em lugar nenhum
    // e sem bloquear vias/estações diferentes entre si.
    const claimed = await claimPrintJob({ kind: 'order', id: order.id, station });
    if (!claimed) {
      log(`⏭️  Pedido ${order.id} — via "${station}" já está em processamento ou concluída por outro Agente — pulando (anti-duplicidade).`);
      continue;
    }
    const r = await printSingleStation(order, station);
    if (r.ok && !r.skipped) anyPrinted = true;
    if (!r.skipped) await reportPrintResult(order, station, r.ok, r.error);
  }
  return anyPrinted;
}

// v54: reimpressão/impressão sob demanda de UMA via, pedida manualmente do painel (botão
// "🖨 Imprimir/Reimprimir") — pode partir de QUALQUER aparelho logado (celular ou PC), o
// servidor só repassa o pedido por SSE e este agente (ligado na impressora física) executa.
// Só imprime se a via pedida for uma das que ESTE agente cuida (evita duplicar quando tem
// mais de um agente rodando, cada um numa impressora/estação diferente).
// v60: agora também avisa o servidor do resultado (sucesso/falha) — é o que fecha o ciclo do
// "celular como controle remoto": tocou em Imprimir no celular, o PC imprime, e a confirmação
// (ou o erro) volta pra tela de quem clicou, em tempo real.
async function printOnDemand(order, station) {
  if (!MY_STATIONS.includes(station)) return;
  // v106 — REMOVIDA a checagem isAuthorizedToPrint() daqui (era a mesma trava de "Estação
  // Ativa" removida de printOrder acima). Impressão MANUAL/reimpressão (clique explícito em
  // "Imprimir", de qualquer aparelho — PC ou celular) SEMPRE deve funcionar quando pedida de
  // propósito, sem depender de qual painel está "ativo" em outro computador — é exatamente o
  // comportamento pedido no v106 (#8: "Desligar a impressão automática NÃO pode desativar a
  // impressão manual" — o mesmo vale pra travas de estação). Sem checagem extra de duplicidade
  // aqui de propósito: reimprimir a pedido do usuário sempre deve sair, mesmo que já tenha
  // impresso antes.
  log(`🖨️  Impressão sob demanda pedida pra via "${station}" — pedido ${order.id} (${order.name || 'sem nome'}).`);
  const r = await printSingleStation(order, station);
  await reportPrintResult(order, station, r.ok, r.error);
}

// v46: teste de impressão pedido pelo painel ("🖨 Testar" numa via com método Automática) —
// imprime só se essa via for uma das que ESTE agente cuida (evita confusão quando tem mais de
// um agente rodando, cada um numa impressora diferente).
// v55: também escolhe a impressora certa (USB/Rede 1/Rede 2) pra essa via automaticamente.
async function printTestTicket(payload) {
  if (!MY_STATIONS.includes(payload.station)) return;
  const printerCfg = printerForStation(payload.station);
  if (!printerCfg) { log(`⚠️  Nenhuma impressora configurada pra via "${payload.station}" — teste não enviado.`); return; }
  if (TEST_MODE) { log(`🧪 [TEST_MODE] Teste de impressão pra via "${payload.station}" (impressora: ${printerCfg.label}):\n   ` + String(payload.text || '').split('\n').join('\n   ')); return; }
  const printer = buildPrinter(printerCfg);
  const isWinPrinter = isWindowsNamedPrinter(printerCfg);
  try {
    if (!isWinPrinter) {
      const connected = await printer.isPrinterConnected();
      if (!connected) throw new Error(`Impressora "${printerCfg.label}" não respondeu.`);
    }
    printer.alignCenter(); printer.bold(true);
    printer.println('TESTE DE IMPRESSAO');
    printer.bold(false);
    // v93 — BUG CORRIGIDO ("impressora ainda não está atualizando tamanho da fonte"): o teste
    // de impressão (botão "🖨 Testar" em Configurações) sempre imprimia em tamanho padrão,
    // ignorando cfg.printSize por completo — era exatamente o que a pessoa usava pra conferir
    // se o tamanho tinha mudado, então parecia que a configuração nunca fazia efeito nenhum.
    const tam = tamanhoImpressaoTermica(payload.fontSize);
    printer.setTextSize(tam.h, tam.w);
    printer.println('Via: ' + (payload.label || payload.station));
    printer.println('Impressora: ' + printerCfg.label);
    printer.println(new Date().toLocaleString('pt-BR'));
    printer.setTextNormal();
    printer.newLine(); printer.cut();
    printer.beep(2, 2); // v126 — bipe duplo também no teste de impressão (consistência)
    if (isWinPrinter) {
      sendRawBufferToWindowsPrinter(windowsPrinterName(printerCfg), printer.getBuffer());
    } else {
      await printer.execute();
    }
    log(`✅ Teste de impressão da via "${payload.station}" concluído na impressora "${printerCfg.label}".`);
  } catch (err) {
    log(`❌ Falha no teste de impressão (via "${payload.station}", impressora "${printerCfg.label}"): ${err.message}`);
  }
}

// ─── Conexão com o servidor (login + escuta de eventos em tempo real) ───
let token = null;
// v-bugfix (sessões acumulando sem parar): cada reconexão chamava login() de novo, mesmo com um
// token ainda válido — como o servidor mantém a sessão válida por 12h, isso criava uma sessão
// NOVA no servidor a cada queda de conexão (comum: rede instável, deploy, cold start do
// hospedeiro), sem nunca reaproveitar a anterior. Com o tempo, acumulou dezenas de milhares de
// sessões no backup do servidor, deixando o arquivo pesado demais e contribuindo pra lentidão no
// boot. Agora guardamos até quando ESTE token deve durar (com margem de segurança abaixo das 12h
// reais) e só pedimos login novo quando de fato não temos mais um token utilizável.
let tokenExpiresAt = 0;
const TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 11; // 11h — 1h de margem abaixo das 12h do servidor
let retryDelay = 2000; // cresce com backoff até um teto, evita martelar o servidor se ele cair

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(u, {
      method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function login() {
  const r = await request('POST', `${cfg.serverUrl}/api/login`, { username: cfg.username, password: cfg.password });
  if (r.status !== 200 || !r.data || !r.data.token) throw new Error('Login falhou — confira usuário/senha no config.json.');
  token = r.data.token;
  tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
  log(`🔑 Login OK (${cfg.username}).`);
  announcePresence();
  startStationStatusPolling();
  startPendingRecoveryPolling();
}

// v82: avisa o servidor "estou vivo" logo após logar, e de novo a cada ~45s enquanto o agente
// estiver rodando — é o que faz o painel (Central de Impressão) mostrar "✅ Agente conectado"
// ou "❌ Nenhum agente conectado" em tempo real, em vez do admin ter que adivinhar olhando só
// pro resultado (ou a falta dele) na impressora física.
let announceTimer = null;
async function announcePresence() {
  try {
    await request('POST', `${cfg.serverUrl}/api/print-agent/announce?token=${encodeURIComponent(token)}`, {
      agentId: AGENT_ID,
      printers: PRINTERS.map(p => ({ label: p.label, stations: p.stations })),
      build: AGENT_BUILD, // v95: mostra no painel qual versão do código está rodando de fato agora
    });
  } catch (e) { /* se falhar, o painel simplesmente mostra "offline" até o próximo aviso — não trava nada aqui */ }
  clearTimeout(announceTimer);
  announceTimer = setTimeout(announcePresence, 45000);
}

// v90: Estação Ativa de Impressão — guarda o ÚLTIMO status conhecido do servidor (quem é a
// estação ativa agora, e se o Painel está aberto em ALGUM lugar) num cache local, atualizado a
// cada STATION_STATUS_POLL_MS — assim a checagem em isAuthorizedToPrint() (chamada em CADA
// impressão) é instantânea, sem esperar nenhuma requisição de rede na hora de imprimir.
// v93 — BUG CRÍTICO CORRIGIDO: esse polling só rodava quando "stationId" estava configurado no
// config.json. Na v92, a checagem "o Painel está aberto em algum lugar" virou OBRIGATÓRIA pra
// TODO agente (com ou sem stationId) — mas sem o polling rodando, `stationStatus` nunca era
// preenchido pros agentes sem stationId (o caso mais comum), e a impressão automática ficava
// SEMPRE bloqueada, silenciosamente. Agora o polling roda sempre, independente de stationId.
let stationStatus = null; // { active, activeStationId, activeLabel, checkedAt }
let stationStatusTimer = null;
const STATION_STATUS_POLL_MS = 8000;
async function refreshStationStatus() {
  if (!token) return;
  try {
    const r = await request('GET', `${cfg.serverUrl}/api/print-station/status?token=${encodeURIComponent(token)}`);
    if (r.status === 200 && r.data) stationStatus = { ...r.data, checkedAt: Date.now() };
  } catch (e) { /* mantém o último status conhecido; se ficar velho demais, isAuthorizedToPrint() já bloqueia por segurança */ }
}
function startStationStatusPolling() {
  refreshStationStatus();
  clearInterval(stationStatusTimer);
  stationStatusTimer = setInterval(refreshStationStatus, STATION_STATUS_POLL_MS);
}

// v90: decide se ESTE Agente está autorizado a imprimir AGORA.
//   • Sem "stationId" no config.json (padrão) → sempre autorizado, exatamente como sempre
//     funcionou (modo compatível/legado — não quebra ninguém que já usa o sistema hoje).
//   • Com "stationId" configurado → só autorizado se o servidor confirmou, recentemente, que
//     esse é o stationId da estação ATIVA agora (Painel aberto/conectado NESTE computador).
//     Se o último status conhecido estiver velho demais (internet caiu, servidor fora do ar),
//     prefere BLOQUEAR a arriscar imprimir em duplicidade — a impressão automática desse
//     pedido específico fica pendente até a conexão voltar (o pedido continua salvo
//     normalmente, só a via automática desse Agente é que não sai até confirmar de novo).
// v92 — BUG CORRIGIDO ("o agente não deve imprimir nada com o sistema fechado"): antes dessa
// checagem só entrava em ação quando "stationId" estava configurado no config.json (recurso
// opcional pra evitar imprimir em dobro com 2 agentes ligados ao mesmo tempo) — sem isso
// configurado (o caso mais comum), o Agente sempre se considerava autorizado, mesmo que
// NINGUÉM tivesse o Painel aberto em lugar nenhum. Agora a checagem de "o Painel está aberto
// AGORA em algum computador" (mesmo heartbeat que já existia pra decidir a Estação Ativa, ver
// server.js) vira OBRIGATÓRIA sempre — com ou sem stationId configurado. O stationId continua
// como uma checagem A MAIS, só pra quando tem mais de um Agente instalado.
function isAuthorizedToPrint() {
  if (!stationStatus) return false; // ainda não confirmou nada com o servidor — não arrisca
  const age = Date.now() - stationStatus.checkedAt;
  if (age > STATION_STATUS_POLL_MS * 3) return false; // último status conhecido velho demais
  if (!stationStatus.active) return false; // painel fechado em todo lugar agora — não imprime
  if (!STATION_ID) return true; // sem stationId configurado: só a checagem acima já basta
  return stationStatus.activeStationId === STATION_ID;
}

let pendingPollTimer = null;
let pendingPollBusy = false;
async function recoverPendingPrints() {
  if (!token || pendingPollBusy) return;
  pendingPollBusy = true;
  try {
    const r = await request('GET', `${cfg.serverUrl}/api/print-agent/pending?token=${encodeURIComponent(token)}`);
    if (r.status !== 200 || !r.data) return;
    const orders = Array.isArray(r.data.orders) ? r.data.orders : [];
    const reservations = Array.isArray(r.data.reservations) ? r.data.reservations : [];
    if (orders.length || reservations.length) log(`🔄 Recuperação de impressão: ${orders.length} pedido(s), ${reservations.length} reserva(s) pendente(s).`);
    for (const order of orders) {
      try { await printOrder({ ...order, _printFontSize: order._printFontSize || cfg.printSize, _autoAcceptOn: true }); }
      catch (e) { log(`⚠️ Falha na recuperação do pedido ${order.id}: ${e.message}`); }
    }
    for (const reservation of reservations) {
      try { await printReservation({ ...reservation, _printFontSize: reservation._printFontSize || cfg.printSize, storeName: cfg.storeName }); }
      catch (e) { log(`⚠️ Falha na recuperação da reserva ${reservation.id}: ${e.message}`); }
    }
  } catch (e) {
    log(`⚠️ Fila de recuperação indisponível: ${e.message}`);
  } finally {
    pendingPollBusy = false;
  }
}
function startPendingRecoveryPolling() {
  clearInterval(pendingPollTimer);
  recoverPendingPrints();
  pendingPollTimer = setInterval(recoverPendingPrints, PENDING_POLL_MS);
}

function connectStream() {
  const u = new URL(`${cfg.serverUrl}/api/stream?token=${encodeURIComponent(token)}`);
  const lib = u.protocol === 'https:' ? https : http;
  log('📡 Conectando ao servidor em tempo real...');

  const req = lib.get(u, (res) => {
    if (res.statusCode !== 200) {
      // v-bugfix: só derruba o token guardado se o servidor disse explicitamente "não
      // autorizado" (401) — qualquer outro status (ex: 502/503 de um deploy em andamento) é
      // problema passageiro do servidor, não do login, então o token continua valendo e a
      // próxima tentativa NÃO precisa logar de novo.
      if (res.statusCode === 401) { token = null; tokenExpiresAt = 0; }
      log(`⚠️  Conexão recusada (status ${res.statusCode}). Tentando de novo em ${retryDelay / 1000}s...`);
      scheduleReconnect();
      return;
    }
    retryDelay = 2000; // conexão ok, reseta o backoff
    log('✅ Conectado — aguardando pedidos novos.');

    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // sobra incompleta fica pro próximo pedaço
      for (const part of parts) {
        const eventLine = part.split('\n').find(l => l.startsWith('event:'));
        const dataLine = part.split('\n').find(l => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice(6).trim();
        if (eventName === 'new-order') {
          try {
            const order = JSON.parse(dataLine.slice(5).trim());
            log(`🆕 Pedido novo recebido: ${order.id} (${order.name})`);
            printOrder(order);
          } catch (e) { log(`⚠️  Não consegui interpretar o pedido recebido: ${e.message}`); }
        } else if (eventName === 'new-reservation-print') {
          // v93: reserva de mesa também imprime — mesmo caminho/trava (só imprime se este
          // computador estiver autorizado, ver isAuthorizedToPrint) do pedido novo.
          try {
            const reservation = JSON.parse(dataLine.slice(5).trim());
            log(`🪑 Reserva nova recebida: ${reservation.id} (${reservation.name})`);
            printReservation(reservation);
          } catch (e) { log(`⚠️  Não consegui interpretar a reserva recebida: ${e.message}`); }
        } else if (eventName === 'print-test') {
          // v46: teste de impressão sob demanda, disparado pelo botão "🖨 Testar" no painel
          // quando a via está configurada como "Automática".
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            log(`🧪 Teste de impressão recebido pra via "${payload.station}".`);
            printTestTicket(payload);
          } catch (e) { log(`⚠️  Não consegui interpretar o teste de impressão: ${e.message}`); }
        } else if (eventName === 'print-order') {
          // v54: impressão/reimpressão manual pedida pelo botão "🖨 Imprimir" do painel —
          // pode ter partido de um celular ou de um PC, tanto faz: o servidor só repassa,
          // este agente (ligado na impressora de verdade) é quem executa.
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            printOnDemand(payload.order, payload.station);
          } catch (e) { log(`⚠️  Não consegui interpretar o pedido de impressão manual: ${e.message}`); }
        }
      }
    });
    res.on('end', () => { log('🔌 Conexão encerrada pelo servidor. Reconectando...'); scheduleReconnect(); });
    res.on('error', (e) => { log(`⚠️  Erro na conexão: ${e.message}. Reconectando...`); scheduleReconnect(); });
  });
  req.on('error', (e) => { log(`⚠️  Não consegui conectar: ${e.message}. Tentando de novo em ${retryDelay / 1000}s...`); scheduleReconnect(); });
}

function scheduleReconnect() {
  setTimeout(async () => {
    try {
      // v-bugfix: reaproveita o token atual enquanto ele ainda estiver dentro da validade —
      // só faz login de novo quando realmente não tem mais um token utilizável (nunca logou,
      // ou o servidor recusou com 401, ou passou da validade). Isso é o que impede uma sessão
      // nova a cada queda de conexão comum (rede, deploy, cold start).
      if (!token || Date.now() >= tokenExpiresAt) {
        await login();
      } else {
        log('🔁 Reconectando com o login já existente (ainda válido) — sem criar sessão nova.');
      }
      connectStream();
    }
    catch (e) { log(`⚠️  ${e.message}`); scheduleReconnect(); }
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 1.5, 60000); // backoff até no máx. 1 minuto entre tentativas
}

// v95 — marcador de versão/build, impresso sempre no início do log. IMPORTANTE: o Agente Local
// roda como processo persistente em segundo plano (Tarefa Agendada do Windows) — trocar os
// arquivos em disco (print-agent.js) NÃO reinicia esse processo sozinho, então qualquer correção
// aqui (como a de tamanho de fonte) só passa a valer de verdade depois de rodar
// REINICIAR-AGENTE.bat. Esse marcador serve pra conferir, olhando o log, se o processo rodando
// agora é realmente a versão mais nova dos arquivos.
const AGENT_BUILD = 'v122 (impressão resiliente + retry + lease anti-duplicidade)';
async function start() {
  log(`🍣 Agente de impressão iniciando (build ${AGENT_BUILD})${TEST_MODE ? ' (TEST_MODE — não vai imprimir de verdade)' : ''}...`);
  log(`ℹ️  Se você acabou de atualizar os arquivos do sistema, confirme que esse número de build bate com o mais recente — senão, rode REINICIAR-AGENTE.bat pra esse processo carregar o código novo (trocar o arquivo no disco sozinho não reinicia quem já está rodando).`);
  log(`🖨️  ${PRINTERS.length} impressora(s) configurada(s):`);
  PRINTERS.forEach(p => log(`   • ${p.label} → vias: ${p.stations.join(', ')} (${p.interface})`));
  try {
    await login();
    connectStream();
  } catch (e) {
    log(`❌ ${e.message}`);
    scheduleReconnect();
  }
}

start();
