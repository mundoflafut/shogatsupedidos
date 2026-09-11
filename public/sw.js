// v36: CORRIGIDO — antes, TUDO (inclusive painel.html) usava "cache primeiro": uma vez que o
// navegador guardava uma cópia, ele nunca mais buscava a versão nova no servidor sozinho — por
// isso o painel do master continuava mostrando botões antigos mesmo depois de uma atualização.
// Agora: páginas HTML (navegação) usam "rede primeiro" — sempre tenta buscar a versão mais nova;
// só usa o cache guardado se estiver sem internet. Arquivos que raramente mudam (ícones, fontes,
// manifest) continuam em cache primeiro, que é mais rápido e não tem esse risco.
// v44: versão do cache subiu (v4 -> v5) junto com o sistema de atualização automática
// (ver public/version-check.js) — isso já faz o próprio evento "activate" abaixo apagar o
// cache antigo sozinho, sem tocar em IndexedDB/localStorage/cookies (dados do cliente).
// v54: sistema virou PWA instalável em TODAS as páginas (antes só index.html tinha o
// manifest ligado, e painel.html registrava o service worker mas nunca tinha manifest
// próprio). Cada área do sistema (painel, rastreio de entrega, cardápios de rodízio,
// avaliação, divulgação, "peça agora") ganhou seu próprio manifest-*.json com nome e
// tela inicial (start_url) certos pra ela — pra abrir direto na página certa quando
// instalada, em vez de sempre cair em "/". Cache sobe de v5 pra v6 pra já entregar esses
// arquivos novos pra quem já tinha o service worker instalado antes.
const CACHE = 'shogatsu-v8';
const ASSETS = [
  '/manifest.json',
  '/manifest-painel.json',
  '/manifest-entregador.json',
  '/manifest-rodizio.json',
  '/manifest-rodizio-popular.json',
  '/manifest-avaliar-rodizio.json',
  '/manifest-divulgacao-rodizio.json',
  '/manifest-pedir-agora.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
  '/apple-touch-icon.png',
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Jost:wght@300;400;500;600&display=swap'
];
// BUG CORRIGIDO (v43 — "notificação push não chega"): o `cache.addAll(ASSETS)` falha por
// inteiro se UM ÚNICO item da lista não puder ser buscado — e o CSS do Google Fonts é
// cross-origin, então qualquer instabilidade de rede/CORS nele derruba a instalação inteira
// do Service Worker. Quando isso acontece, o Service Worker fica travado pra sempre em
// "installing" e nunca chega a "activated" — e como o botão de notificações espera
// `navigator.serviceWorker.ready` (que só resolve depois de "activated"), o clique em
// "Ativar notificações" ficava preso sem nunca terminar, sem erro nenhum. Agora cada arquivo
// é cacheado individualmente: se um falhar, os outros continuam normalmente e a instalação
// sempre termina.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(url => c.add(url).catch(err => console.warn('[sw] não consegui cachear', url, err))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// v44: permite que public/version-check.js peça pro Service Worker assumir na hora, sem
// esperar todas as abas fecharem — parte do sistema de atualização automática.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isHtmlRequest(request){
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', e => {
  // Pedidos, status e config sempre direto da rede — nunca cachear
  if (e.request.url.includes('/api/')) return;

  // Páginas HTML (index, painel, cardápios, etc.): rede primeiro, sempre. Isso garante que
  // qualquer atualização publicada no servidor aparece na próxima vez que a página recarregar,
  // sem precisar limpar cache manualmente. Só cai pro cache se estiver realmente offline.
  if (isHtmlRequest(e.request)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Resto (ícones, fontes, css/js estático): cache primeiro, mais rápido e raramente muda.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// ─── Notificações Push (promoções, cupons, novidades, status do pedido) ───
// v44: reforçado o alerta sonoro/tátil dessas notificações. O navegador não deixa a gente
// anexar um arquivo de áudio próprio numa Notification (isso é decidido pelo sistema
// operacional) — o que dá pra garantir é NÃO silenciar (silent:false, que já é o padrão, mas
// deixamos explícito) e adicionar vibração no celular, que funciona junto com o som do sistema.
// v81: BUG CORRIGIDO ("alerta push simultâneo às vezes não chega em nenhum aparelho") — o
// pedido novo e a reserva nova sempre usavam a MESMA `tag` fixa pra toda notificação daquele
// tipo (ex: sempre "shogatsu-novo-pedido"). Isso é intencional pro navegador AGRUPAR/SUBSTITUIR
// notificações com a mesma tag — só que sem `renotify:true`, substituir uma notificação que
// ainda não foi vista/dispensada acontece EM SILÊNCIO: sem som, sem vibração, sem a tela
// acender de novo. Numa loja corrida, se o alerta anterior ainda está lá parado na tela do
// celular, o próximo pedido literalmente "chega" (a notificação existe, o navegador confirma
// 201/OK), só que ninguém percebe. `renotify:true` faz o navegador sempre re-alertar (som +
// vibração) mesmo substituindo uma tag existente. As tags de pedido/reserva também passaram a
// levar o ID do pedido/reserva (ver server.js), então nem chegam a colidir na prática — isso
// aqui é a segunda camada de proteção, pro caso de algum outro aviso repetir a mesma tag.
// v82: BUG CORRIGIDO ("notificação push parou de chegar" — regressão da v81) — a partir da
// v81 o `silent` passou a vir por aparelho (`!!data.silent`), mas a API de notificações do
// navegador PROÍBE `silent:true` junto com `vibrate` — chamar showNotification() com essa
// combinação lança um TypeError na hora (é assim na especificação, não é um detalhe de
// implementação de um navegador só). Como esse throw acontece de forma síncrona, dentro do
// próprio evento 'push' (não dentro de uma Promise), ele nunca era pego por nenhum catch — o
// service worker falhava o evento inteiro e NENHUMA notificação aparecia, pra nenhum aparelho,
// sempre que esse aparelho estivesse com "🔇 Silenciar som do sistema" ativado. Corrigido
// tirando `vibrate` da lista de opções quando `silent` é true (que já é, por definição, quando
// não faz sentido vibrar mesmo).
self.addEventListener('push', e => {
  let data = { title: 'Shogatsu', body: 'Você tem uma novidade!', url: '/' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (err) { /* usa os valores padrão acima */ }
  const isSilent = !!data.silent;
  const notifOptions = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    image: data.image || undefined, // v45: banner grande, estilo apps de delivery (iFood etc)
    badge: '/icon-72.png',
    data: { url: data.url || '/' },
    // v81: o volume do som do sistema é controlado pelo próprio aparelho (Android/iOS/
    // navegador) — não existe jeito, pela API padrão do navegador, de definir um volume
    // customizado pra notificação. O que dá pra controlar é só ligar/desligar esse som:
    // quando o admin ativa "🔇 Silenciar som do sistema neste aparelho" (Configurações →
    // 🔔 Notificações Push), o servidor manda `silent:true` só pra esse aparelho, e quem
    // avisa nele é o som do próprio painel (que aí sim respeita o volume configurado) —
    // funciona enquanto o painel estiver aberto nesse aparelho.
    silent: isSilent,
    requireInteraction: false,
    renotify: true,
    tag: data.tag || 'shogatsu-update'
  };
  // v82: só adiciona `vibrate` quando NÃO é silencioso — combinar os dois é proibido pela API
  // (ver comentário acima) e o navegador nem chega a mostrar a notificação se isso acontecer.
  if (!isSilent) notifOptions.vibrate = [200, 100, 200, 100, 200];
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, notifOptions),
      // v45: quem já está com o site/painel aberto na hora não depende só do som do sistema —
      // avisa a página pra tocar o sino oriental sintetizado (ver index.html/painel.html).
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        list.forEach(c => c.postMessage({ type: 'shogatsu-push-sound', sound: data.sound || 'oriental' }));
      })
    ])
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url.includes(url) && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// v80: BUG CORRIGIDO ("notificação push parou de chegar no celular") — navegadores (Chrome no
// Android é o caso mais comum) podem invalidar/trocar a inscrição push sozinhos em segundo
// plano (rotação de segurança do próprio serviço de push do Google/Mozilla), sem avisar a
// página. Sem tratar isso, o navegador AINDA MOSTRA "notificações ativadas" no app, mas o
// endpoint salvo no servidor virou inválido — as notificações somem de vez, silenciosamente,
// sem nenhum erro visível pra ninguém. O evento abaixo é o jeito padrão de reagir a isso: gera
// uma inscrição nova sozinho e manda pro servidor atualizar, sem o cliente precisar desativar e
// reativar manualmente. Funciona tanto pro chat/pedidos do cliente quanto pro alerta do painel —
// cada lado grava, na hora que ativa, um "recibo" (cache) com os dados que precisa reenviar; aqui
// só lemos esse recibo de volta.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const cache = await caches.open('shogatsu-push-meta');
      const oldOptions = e.oldSubscription ? e.oldSubscription.options : null;
      let applicationServerKey = oldOptions && oldOptions.applicationServerKey;
      if (!applicationServerKey) {
        const keyRes = await fetch('/api/push/vapid-public-key');
        const { publicKey } = await keyRes.json();
        if (!publicKey) return;
        const padding = '='.repeat((4 - publicKey.length % 4) % 4);
        const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        applicationServerKey = Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
      }
      const newSub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      const clienteMeta = await cache.match('/__push-meta__/cliente');
      if (clienteMeta) {
        const meta = await clienteMeta.json();
        await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: newSub.toJSON(), phone: meta.phone || '' }) }).catch(() => {});
      }
      const adminMeta = await cache.match('/__push-meta__/admin');
      if (adminMeta) {
        const meta = await adminMeta.json();
        await fetch('/api/admin/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(meta.token ? { Authorization: 'Bearer ' + meta.token } : {}) },
          body: JSON.stringify({ subscription: newSub.toJSON(), deviceLabel: meta.deviceLabel || 'Aparelho' })
        }).catch(() => {});
      }
    } catch (err) { /* se falhar, o alerta simplesmente para de chegar nesse aparelho até reativar na mão — não quebra nada mais */ }
  })());
});
