/**
 * ProxyCard - construção dos cartões da biblioteca de proxies.
 *
 * Os cartões são montados com a API do DOM e todo texto vindo da API entra por
 * `textContent`, então nada é interpretado como HTML (não há utilitário de
 * escape e nomes/hosts com caracteres especiais continuam seguros).
 */
const ProxyCard = {
  /* Ícones SVG inline (a UI não usa emoji como elemento de interface). */
  icons: {
    plug:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 18v4"/></svg>',
    bolt:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20 6 9 17l-5-5"/></svg>',
    x:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6 6 18M6 6l12 12"/></svg>'
  },

  /* ---------- helpers de DOM ---------- */

  /** Cria um elemento com classe e, opcionalmente, texto. */
  _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  },

  /** Ícone SVG (markup constante) com a classe pedida. */
  _icon(name, className) {
    const box = this._el('span');
    box.innerHTML = this.icons[name] || '';
    const svg = box.firstElementChild;
    if (svg) svg.setAttribute('class', className || 'icon');
    return svg || box;
  },

  /** Linha rótulo/valor. O valor pode ser texto ou um nó. */
  _row(label, value) {
    const row = this._el('div', 'info-row');
    const valueBox = this._el('span', 'info-value');
    if (value && value.nodeType === 1) valueBox.append(value);
    else valueBox.textContent = String(value == null ? '—' : value);
    row.append(this._el('span', 'info-label', label), valueBox);
    return row;
  },

  /** Bandeira do país (flagcdn) a partir do countryCode. */
  _flag(code) {
    const cc = String(code || '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return null;
    const flag = this._el('span', 'proxy-flag');
    flag.style.backgroundImage = `url('https://flagcdn.com/w40/${cc}.png')`;
    flag.setAttribute('aria-hidden', 'true');
    return flag;
  },

  /* ---------- cartão ---------- */

  /**
   * Cartão completo de um proxy.
   * @param {object} proxy  item de GET /api/proxies
   * @param {object|string} [result] resultado do teste, 'loading' ou undefined
   * @returns {HTMLElement}
   */
  el(proxy, result) {
    const card = this._el('article', 'proxy-card');
    card.dataset.proxyCard = String(proxy.id);
    card.setAttribute('role', 'listitem');

    // Topo: ícone + nome/endereço + selo de autenticação
    const avatar = this._el('span', 'proxy-card-avatar');
    avatar.append(this._icon('plug'));

    const name = this._el('h3', 'proxy-card-name', proxy.name || 'Proxy');
    name.title = proxy.name || '';

    const address = `${proxy.host}:${proxy.port}`;
    const host = this._el('span', 'proxy-card-host', address);
    host.title = address;

    const addr = this._el('p', 'proxy-card-addr');
    addr.append(host, this._el('span', 'proxy-card-scheme', String(proxy.scheme || 'http').toUpperCase()));

    const ident = this._el('div', 'proxy-card-ident');
    ident.append(name, addr);

    // País do último teste: é o dado que interessa ao escolher o proxy, e vai
    // em linha própria para não apertar o endereço nem o selo de autenticação.
    const country = this.countryEl(proxy);
    if (country) {
      const countryRow = this._el('p', 'proxy-card-country-row');
      countryRow.append(country);
      ident.append(countryRow);
    }

    const badge = this._el('span', proxy.auth ? 'type-badge proxy' : 'type-badge',
      proxy.auth ? 'autenticado' : 'aberto');

    const top = this._el('div', 'proxy-card-top');
    top.append(avatar, ident, badge);
    card.append(top);

    // Usuário (só quando o proxy é autenticado)
    if (proxy.auth) {
      const userBox = this._el('div', 'proxy-card-user');
      const user = this._el('code', 'proxy-card-user-value', proxy.username || '—');
      user.title = proxy.username || '';
      userBox.append(this._el('span', 'proxy-card-user-label', 'Usuário'), user);
      card.append(userBox);
    }

    // Resultado do último teste. Sem resultado em memória, mostra o que ficou
    // guardado do último teste (a página continua útil depois de um reload).
    const resultBox = this._el('div', 'proxy-card-result');
    resultBox.dataset.proxyResult = String(proxy.id);
    resultBox.append(this.resultEl(result === undefined ? this.storedResult(proxy) : result));
    card.append(resultBox);

    // Ações
    const testBtn = this._el('button', 'btn btn-secondary btn-sm proxy-card-test');
    testBtn.type = 'button';
    testBtn.dataset.proxyTest = String(proxy.id);
    const testLabel = this._el('span', 'btn-text', 'Testar');
    const testLoading = this._el('span', 'btn-loading');
    testLoading.append(this._el('span', 'spinner'));
    testBtn.append(this._icon('bolt'), testLabel, testLoading);

    const removeBtn = this._el('button', 'btn btn-secondary btn-sm proxy-card-remove');
    removeBtn.type = 'button';
    removeBtn.dataset.proxyRemove = String(proxy.id);
    removeBtn.title = 'Remover proxy';
    removeBtn.setAttribute('aria-label', `Remover ${proxy.name || 'proxy'}`);
    removeBtn.append(this._icon('trash'));

    const actions = this._el('div', 'proxy-card-actions');
    actions.append(testBtn, removeBtn);
    card.append(actions);

    return card;
  },

  /* ---------- resultado do teste ---------- */

  /** @returns {HTMLElement} bloco do resultado (ou o convite para testar). */
  resultEl(result) {
    if (result === 'loading') {
      const box = this._el('div', 'proxy-test-card loading');
      box.append(this._el('span', 'spinner'), this._el('span', 'proxy-test-loading', 'Testando…'));
      return box;
    }

    if (!result) {
      const idle = this._el('p', 'proxy-test-idle');
      idle.append(this._icon('clock'), this._el('span', null, 'Ainda não testado'));
      return idle;
    }

    if (result.live) {
      const box = this._el('div', 'proxy-test-card live');
      const head = this._el('div', 'proxy-test-head');
      head.append(this._el('span', 'proxy-test-status ok', 'LIVE'));
      if (result.latencyMs != null) {
        head.append(this._el('span', 'proxy-test-latency', `${result.latencyMs} ms`));
      }
      if (result.stored) {
        head.append(this._el('span', 'proxy-test-stored', 'último teste'));
      }
      box.append(head, this._el('p', 'proxy-test-ip', result.ip || '—'));

      const local = [result.city, result.country].filter(Boolean).join(', ') || '—';
      const flag = this._flag(result.countryCode);
      const localValue = this._el('span');
      if (flag) localValue.append(flag);
      localValue.append(document.createTextNode(local));

      const grid = this._el('div', 'proxy-test-grid');
      grid.append(
        this._row('Local', localValue),
        this._row('Fuso', result.timezone || '—'),
        this._row('ISP', result.isp || '—')
      );
      box.append(grid);
      return box;
    }

    const dead = this._el('div', 'proxy-test-card dead');
    const head = this._el('div', 'proxy-test-head');
    head.append(this._el('span', 'proxy-test-status bad', 'MORTO'));
    if (result.latencyMs) head.append(this._el('span', 'proxy-test-latency', `${result.latencyMs} ms`));
    dead.append(head, this._el('p', 'proxy-test-error', result.error || 'Proxy indisponível'));
    return dead;
  },

  /* ---------- país ---------- */

  /** Bandeira + país (e cidade) do proxy, ou null quando ainda não se sabe. */
  countryEl(proxy) {
    const line = typeof ProxyLabel !== 'undefined' ? ProxyLabel.countryLine(proxy) : null;
    if (!line) return null;

    const chip = this._el('span', 'proxy-card-country');
    chip.title = 'País do último teste';
    const flag = this._flag(proxy.countryCode);
    if (flag) chip.append(flag);
    chip.append(document.createTextNode(line));
    return chip;
  },

  /** Converte a geo guardada no proxy no mesmo formato do resultado do teste. */
  storedResult(proxy) {
    if (!proxy || !proxy.country) return undefined;
    return {
      live: true,
      stored: true,
      ip: proxy.geoIp || null,
      country: proxy.country,
      countryCode: proxy.countryCode || null,
      city: proxy.city || null,
      timezone: proxy.timezone || null,
      isp: proxy.isp || null,
      latencyMs: null
    };
  },

  /* ---------- resumo do proxy escolhido (criação de instância) ---------- */

  /**
   * Resumo compacto do proxy escolhido para uma nova instância.
   * Mostra ONDE o proxy sai (país, cidade, fuso, IP) — não o endereço.
   * @param {object} proxy item de GET /api/proxies
   * @returns {HTMLElement}
   */
  pickSummaryEl(proxy) {
    const box = this._el('div', 'proxy-picked-card');

    const line = typeof ProxyLabel !== 'undefined' ? ProxyLabel.countryLine(proxy) : null;
    const head = this._el('div', 'proxy-picked-head');
    const flag = this._flag(proxy.countryCode);
    if (flag) head.append(flag);
    head.append(this._el('span', 'proxy-picked-country', line || 'País ainda não identificado'));
    box.append(head);

    const grid = this._el('div', 'proxy-test-grid');
    if (proxy.timezone) grid.append(this._row('Fuso', proxy.timezone));
    if (proxy.geoIp) grid.append(this._row('IP de saída', proxy.geoIp));
    if (proxy.testedAt) grid.append(this._row('Testado em', proxy.testedAt));
    if (grid.childElementCount) box.append(grid);

    if (!line) {
      box.append(this._el('p', 'proxy-picked-hint',
        'Teste este proxy na página Proxies para identificar o país de saída.'));
    }
    return box;
  },

  /* ---------- feedback da importação em lote ---------- */

  /** @returns {HTMLElement} resumo da importação, mostrado dentro do modal. */
  bulkFeedbackEl(imported, skipped, total) {
    const ok = imported > 0;
    const box = this._el('div', `proxies-feedback-box ${ok ? 'ok' : 'bad'}`);

    const title = this._el('p', 'proxies-feedback-title');
    title.append(
      this._icon(ok ? 'check' : 'x'),
      this._el('span', null, ok ? `Importados ${imported} de ${total}` : 'Nenhum proxy novo na lista')
    );

    box.append(
      title,
      this._el('p', 'proxies-feedback-detail',
        `${imported} adicionado(s) · ${skipped} ignorado(s) (repetido ou inválido)`)
    );
    return box;
  }
};
