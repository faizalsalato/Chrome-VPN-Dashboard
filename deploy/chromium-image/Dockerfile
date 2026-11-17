# Imagem do Chromium (LinuxServer) SEM o --test-type.
#
# Por que existe: a imagem oficial lscr.io/linuxserver/chromium embute, no
# wrapper /usr/bin/wrapped-chromium, um conjunto FIXO de flags de Chrome. Uma
# delas e o --test-type, que marca o navegador como "modo de teste" - estado que
# alguns servicos de login e detectores de anti-bot conseguem ver. O dashboard
# nao tem como desliga-la pelo CHROME_CLI, que so ACRESCENTE argumentos.
#
# Esta imagem remove SO essa linha. Todo o resto do wrapper continua igual
# (--no-sandbox, --password-store, --simulate-outdated-no-au, --start-maximized,
# --user-data-dir, WAYLAND/ACCESSIBILITY), assim como o Selkies, o s6-overlay, o
# /config e o PUID/PGID. Nada mais e tocado.
#
# O CloakBrowser NAO usa esta imagem: la o --test-type ja e opt-in, ligado por
# CLOAKBROWSER_TEST_TYPE (ver cloakbrowser.service). Esta imagem e so do
# navegador Chromium.
#
# Efeito colateral esperado: sem --test-type, o Chromium volta a mostrar o
# infobar amarelo "unsupported command-line flag: --no-sandbox" em modo headed.
ARG CHROMIUM_BASE_IMAGE=lscr.io/linuxserver/chromium:latest
FROM ${CHROMIUM_BASE_IMAGE}

# Apaga a linha do --test-type. O sed -i e o caminho simples: a flag aparece uma
# unica vez no wrapper e nao ha regex com escape para errar.
RUN sed -i '/--test-type/d' /usr/bin/wrapped-chromium \
 && chmod 0755 /usr/bin/wrapped-chromium \
 && ! grep -q -- '--test-type' /usr/bin/wrapped-chromium \
 && grep -q -- '--no-sandbox' /usr/bin/wrapped-chromium

# Etiqueta que guarda a impressao da receita (ver chromium-image.service): sem
# ela, uma imagem antiga continuaria a ser usada depois de a receita mudar.
ARG DASHBOARD_RECIPE=unknown
LABEL dashboard.recipe=${DASHBOARD_RECIPE}