/**
 * Listas de país por provedor (as que o gluetun aceita).
 *
 * Cada provedor tem a sua lista e a sua grafia: a ExpressVPN chama «USA» aos
 * Estados Unidos e «UK» ao Reino Unido, e tem «India (via UK)» em vez de
 * «India». Usar a lista errada dá "the country specified is not valid" e o
 * túnel nem arranca.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'vpn-countries.js');

/** Carrega o módulo do frontend (script clássico, sem exports). */
function load() {
  const source = fs.readFileSync(MODULE_PATH, 'utf-8');
  const context = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.__countries = VpnCountries;`, context);
  return context.__countries;
}

const VpnCountries = load();

describe('vpn-countries — listas por provedor', () => {
  it('tem uma lista grande para cada provedor', () => {
    expect(VpnCountries.for('surfshark').length).toBeGreaterThan(90);
    expect(VpnCountries.for('expressvpn').length).toBeGreaterThan(80);
  });

  it('não repete países', () => {
    for (const provider of ['surfshark', 'expressvpn']) {
      const list = VpnCountries.for(provider);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('usa na ExpressVPN os nomes que o gluetun aceita', () => {
    const lista = VpnCountries.for('expressvpn');

    expect(lista).toContain('USA');
    expect(lista).toContain('UK');
    expect(lista).toContain('India (via UK)');
    // Os nomes "por extenso" são os que a ExpressVPN recusa.
    expect(lista).not.toContain('United States');
    expect(lista).not.toContain('United Kingdom');
  });

  it('na Surfshark usa os nomes por extenso', () => {
    const lista = VpnCountries.for('surfshark');

    expect(lista).toContain('United States');
    expect(lista).toContain('United Kingdom');
    expect(lista).toContain('India');
  });

  it('provedor desconhecido cai na lista da Surfshark', () => {
    expect(VpnCountries.for('outrovpn')).toBe(VpnCountries.for('surfshark'));
  });

  it('fill troca as opções do select e mantém o valor quando ele existe', () => {
    // Num <select> real, trocar as opções repõe o valor na primeira delas —
    // é isso que o duplo imita (sem DOM no teste).
    function fakeSelect(value) {
      const el = { value, _html: '' };
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(html) {
          el._html = html;
          el.value = (html.match(/value="([^"]+)"/) || [])[1] || '';
        }
      });
      return el;
    }

    const select = fakeSelect('Germany');
    VpnCountries.fill(select, 'expressvpn');

    expect(select.innerHTML).toContain('<option value="USA">USA</option>');
    expect(select.innerHTML).not.toContain('United States');
    expect(select.value).toBe('Germany');

    // Um valor que não existe na lista nova não pode ficar selecionado.
    const outro = fakeSelect('United States');
    VpnCountries.fill(outro, 'expressvpn');
    expect(outro.value).not.toBe('United States');
  });
});
