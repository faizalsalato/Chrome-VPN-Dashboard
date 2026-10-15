/*
 * Som do container no cliente web do KasmVNC.
 *
 * Por que existe: o KasmVNC não transmite áudio (ver o cabeçalho do
 * audio-bridge.py), então a imagem injeta este script no index.html do próprio
 * KasmVNC. Ele liga o som da instância: busca o fluxo PCM da ponte (`/audio`, no
 * mesmo host/porta do cliente, via roteador) e alimenta um AudioContext.
 *
 * Por que botão e não automático: o Chrome só deixa um AudioContext sair do
 * silêncio depois de um gesto do usuário. O botão é esse gesto. A escolha fica
 * lembrada e, na próxima visita, o som tenta voltar sozinho.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'kasm-audio-on';
  var CHUNK_MS = 20;

  // Buffer circular com o PCM já decodificado (Float32 intercalado).
  var ring = null;
  var write = 0;
  var read = 0;

  var context = null;
  var node = null;
  var reader = null;
  var channels = 1;
  var running = false;

  function desired() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function remember(on) {
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch (error) {
      // Sem localStorage (modo restrito): a escolha vale só nesta página.
    }
  }

  /* Um segundo de som de folga: cobre o tremor da rede sem virar atraso. */
  function makeRing(rate, count) {
    var total = rate * count;
    total -= total % count; // múltiplo dos canais: os quadros ficam inteiros
    ring = new Float32Array(total);
    write = 0;
    read = 0;
  }

  function push(samples) {
    for (var i = 0; i < samples.length; i++) {
      ring[write] = samples[i];
      write = (write + 1) % ring.length;
      // Buffer cheio: descarta o som mais velho (o atraso não cresce sem fim).
      if (write === read) read = (read + 1) % ring.length;
    }
  }

  /* Enche o bloco de saída a partir do buffer; sem som, silêncio. */
  function fill(output) {
    var targets = [];
    for (var channel = 0; channel < output.numberOfChannels; channel++) {
      targets.push(output.getChannelData(channel));
    }

    for (var i = 0; i < output.length; i++) {
      if (read === write) {
        for (var c = 0; c < targets.length; c++) targets[c][i] = 0;
        continue;
      }
      for (var t = 0; t < targets.length; t++) {
        targets[t][i] = ring[(read + (t % channels)) % ring.length];
      }
      read = (read + channels) % ring.length;
    }
  }

  function onAudio(event) {
    fill(event.outputBuffer);
  }

  /* PCM s16le cru → Float32 (o que o Web Audio consome). */
  function decode(value) {
    var view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    var samples = new Float32Array(Math.floor(view.byteLength / (2 * channels)) * channels);
    for (var i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    return samples;
  }

  /* Lê o fluxo da ponte e vai enchendo o buffer. */
  function pump() {
    return reader.read().then(function (result) {
      if (result.done || !running) return;
      if (result.value && result.value.byteLength >= 2 * channels) push(decode(result.value));
      return pump();
    });
  }

  function start() {
    if (running) return;
    running = true;
    setButton(true);

    fetch('/audio', { cache: 'no-store' }).then(function (response) {
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
      channels = Number(response.headers.get('X-Audio-Channels')) || 1;
      var rate = Number(response.headers.get('X-Audio-Rate')) || 24000;

      makeRing(rate, channels);
      var Audio = window.AudioContext || window.webkitAudioContext;
      context = new Audio({ sampleRate: rate });
      node = context.createScriptProcessor(4096, 1, channels);
      node.onaudioprocess = onAudio;
      node.connect(context.destination);
      if (context.resume) context.resume();

      reader = response.body.getReader();
      return pump();
    }).catch(function (error) {
      console.warn('[kasm-audio] som indisponível:', error);
      stop();
    });
  }

  function stop() {
    running = false;
    setButton(false);

    if (reader) {
      var closing = reader;
      reader = null;
      closing.cancel().catch(function () {});
    }
    if (node) {
      node.onaudioprocess = null;
      node.disconnect();
      node = null;
    }
    if (context) {
      context.close().catch(function () {});
      context = null;
    }
    read = 0;
    write = 0;
  }

  var button = null;

  function setButton(on) {
    if (!button) return;
    button.textContent = on ? '🔊 Som' : '🔇 Som';
    button.title = on
      ? 'Som ligado — clique para desligar'
      : 'Som desligado — clique para ligar';
    button.style.background = on ? 'rgba(22,110,58,.92)' : 'rgba(24,28,36,.92)';
  }

  function makeButton() {
    if (button && document.body && document.body.contains(button)) return button;

    button = document.createElement('div');
    button.id = 'kasm-audio-button';
    button.setAttribute('role', 'button');
    button.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:10px',
      'z-index:2147483647',
      'padding:6px 10px',
      'border-radius:6px',
      'border:1px solid rgba(255,255,255,.25)',
      'color:#fff',
      'font:13px/1.2 system-ui,sans-serif',
      'cursor:pointer',
      'user-select:none',
      'box-shadow:0 2px 8px rgba(0,0,0,.45)'
    ].join(';');

    button.addEventListener('click', function () {
      if (running) {
        remember(false);
        stop();
      } else {
        remember(true);
        start();
      }
    });

    document.body.appendChild(button);
    setButton(running);
    return button;
  }

  function boot() {
    makeButton();
    // O cliente do KasmVNC redesenha a página ao conectar/desconectar a sessão:
    // o botão volta a ser posto se for removido.
    window.setInterval(makeButton, 2000);
    // A escolha da visita anterior tenta voltar sozinha; se o navegador ainda
    // exigir gesto, o clique no botão resolve.
    if (desired()) start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
