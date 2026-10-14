/**
 * Isolamento do banco nos testes.
 *
 * Roda antes de qualquer teste carregar um módulo (setupFiles do Jest). A suíte
 * pode executar na mesma máquina — e no mesmo diretório — do dashboard em
 * produção; sem isto, módulos que abrem o SQLite (database, auth) usariam o
 * MESMO arquivo do serviço de verdade. Foi assim que o banco do servidor ficou
 * sem as linhas das instâncias.
 *
 * O arquivo é por processo e vive no diretório temporário do sistema.
 */
const os = require('os');
const path = require('path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `dashboard-test-${process.pid}.db`);
