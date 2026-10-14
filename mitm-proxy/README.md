# MITM Header Proxy

Proxy que intercepta HTTP/HTTPS e reescreve headers HTTP para mascarar o
ambiente de execução (ex.: Linux → Windows/macOS). Feito para uso com
containers de navegadores onde o binário roda em Linux, mas o perfil
desejaria aparecer como outro sistema.

## Estrutura

```
mitm-proxy/
├── index.js               # Ponto de entrada
├── header-utils.js        # Lógica de reescrita de headers
├── ca-manager.js          # Geração/uso de CA para MITM
├── mitm-server.js         # Servidor HTTP/HTTPS com interceptação
├── ca/
│   └── (gerado)           # Certificado CA (gerado na primeira execução)
└── package.json
```

## Como funciona

1. **HTTP** — O proxy intercepta a requisição, reescreve os headers (User-Agent,
   sec-ch-ua-platform, etc.) e encaminha para o destino.
2. **HTTPS** — O proxy usa **MITM (SSL interception)**:
   - Gera/expõe um certificado CA privado.
   - Para cada domínio, gera um certificado assinado pelo CA.
   - O navegador precisa confiar nesse CA (veja abaixo).

## Uso

```bash
# Instalar dependências
npm install

# Iniciar (porta padrão 8888, OS padrão: windows)
npm start

# Ou com opções
PROXY_PORT=9999 PROXY_OS=windows npm start
PROXY_OS=macos npm start
PROXY_OS=android npm start
PROXY_OS=ios npm start
PROXY_OS=linux npm start

# Pular certos hosts (separados por vírgula)
PROXY_SKIP=localhost,internal.example.com npm start

# Log mais detalhado
PROXY_LOG=debug npm start
```

## Configurar o navegador para usar o proxy

### Chrome/Edge (Windows/macOS)

1. Abrir `chrome://settings/system`
2. Configurações de proxy → Rede → Configurações de proxy avançadas
3. Proxy manual → Endereço: `127.0.0.1`, Porta: `8888`
4. Para HTTPS, instalar a CA em: `mitm-proxy/ca/ca_cert.pem`

### Firefox

1. Abrir `about:preferences#network`
2. Configurações de rede → Configurações... → Proxy manual
3. Endereço: `127.0.0.1`, Porta: `8888`
4. Em "Certificados" → Importar `mitm-proxy/ca/ca_cert.pem`

### Chrome no Linux/Android (container)

Para o container, o proxy pode ser configurado via variável de ambiente
ou CLI do Chrome:

```bash
# No Dockerfile ou docker-compose.yml
ENV HTTP_PROXY=http://127.0.0.1:8888
ENV HTTPS_PROXY=http://127.0.0.1:8888
```

## Arquivo de cabeçalhos personalizado

Crie um arquivo `headers.json` na pasta do proxy para sobrescrever os padrões:

```json
{
  "windows": {
    "sec-ch-ua-platform": "\"Windows\"",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
  }
}
```

## Limitações

- **HTTPS MITM** requer que o navegador confie no CA gerado.
- Sites com **HSTS** ou **certificação estrita** podem bloquear a interceptação.
- Compatibilidade com **WebAuthn**, **Passkeys** e outros mecanismos baseados em
  certificados pode ser afetada.
- O proxy **não** executa modificação de conteúdo (HTML/JS) — apenas headers.

## Teste rápido

```bash
# Teste HTTP
curl -x http://127.0.0.1:8888 https://whoer.net/ 2>&1 | head -20

# Verificar headers
curl -x http://127.0.0.1:8888 -I https://whoer.net/ 2>&1 | head -10
```

## Licença

MIT
