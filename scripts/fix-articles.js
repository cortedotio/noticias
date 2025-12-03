#!/usr/bin/env node

/**
 * Script de correção de artigos já capturados
 * 
 * Uso:
 *   node scripts/fix-articles.js --all                    # Corrigir todas as empresas
 *   node scripts/fix-articles.js --company ID_DA_EMPRESA  # Corrigir empresa específica
 *   node scripts/fix-articles.js --status                 # Verificar status
 *   node scripts/fix-articles.js --release-lock          # Liberar lock manualmente
 *   node scripts/fix-articles.js --help                   # Mostrar ajuda
 */

const { getFunctions } = require('./firebase-config');
const path = require('path');

// Cores para output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Funções auxiliares
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logProgress(message) {
  log(`⏳ ${message}`, 'cyan');
}

// Função para chamar função do Firebase
async function callFirebaseFunction(functionName, data = {}) {
  try {
    const functions = getFunctions();
    
    // Usar a região correta (southamerica-east1)
    const fn = functions.region('southamerica-east1').httpsCallable(functionName);
    
    logInfo(`Chamando função: ${functionName}`);
    const result = await fn(data);
    
    return result.data;
  } catch (error) {
    if (error.code === 'unauthenticated') {
      logError('Erro de autenticação - verifique o service account');
    } else if (error.code === 'already-exists') {
      logError('Já existe uma correção em andamento');
    } else {
      logError(`Erro ao chamar ${functionName}: ${error.message}`);
    }
    throw error;
  }
}

// Corrigir todas as empresas
async function fixAllCompanies() {
  logProgress('Iniciando correção de TODAS as empresas...');
  logWarning('Este processo pode demorar vários minutos dependendo da quantidade de artigos');
  
  try {
    const result = await callFirebaseFunction('fixAllCompaniesArticles');
    
    logSuccess('Correção concluída com sucesso!');
    logInfo(`Total de empresas: ${result.totalCompanies}`);
    logInfo(`Total de artigos processados: ${result.totalProcessed}`);
    logInfo(`Total de artigos atualizados: ${result.totalUpdated}`);
    
    if (result.results && result.results.length > 0) {
      logInfo('\nDetalhes por empresa:');
      result.results.forEach(company => {
        if (company.success) {
          logSuccess(`  ${company.companyName}: ${company.updated} de ${company.processed} artigos`);
        } else {
          logError(`  ${company.companyName}: ${company.message}`);
        }
      });
    }
    
    logSuccess(`\n${result.message}`);
    
  } catch (error) {
    logError('Falha na correção geral');
    process.exit(1);
  }
}

// Corrigir empresa específica
async function fixCompany(companyId) {
  logProgress(`Iniciando correção para empresa: ${companyId}`);
  
  try {
    const result = await callFirebaseFunction('fixExistingArticles', { companyId });
    
    logSuccess('Correção concluída com sucesso!');
    logInfo(`Artigos processados: ${result.processed}`);
    logInfo(`Artigos atualizados: ${result.updated}`);
    logInfo(`Erros: ${result.errors}`);
    logSuccess(result.message);
    
  } catch (error) {
    logError(`Falha na correção da empresa ${companyId}`);
    process.exit(1);
  }
}

// Verificar status
async function checkStatus() {
  logInfo('Verificando status da correção...');
  
  try {
    const result = await callFirebaseFunction('checkFixStatus');
    
    if (result.running) {
      logWarning('Correção em andamento!');
      logInfo(`Iniciado em: ${new Date(result.startedAt).toLocaleString()}`);
      logInfo(`Tempo decorrido: ${result.minutesRunning} minutos`);
      logWarning('Aguarde a conclusão antes de iniciar uma nova correção');
    } else {
      logSuccess('Nenhuma correção em andamento');
      logInfo('Você pode iniciar uma nova correção');
    }
    
  } catch (error) {
    logError('Erro ao verificar status');
    process.exit(1);
  }
}

// Liberar lock
async function releaseLock() {
  logWarning('Liberando lock manualmente...');
  logInfo('Use esta opção apenas se tiver certeza de que não há correção em andamento');
  
  try {
    const result = await callFirebaseFunction('releaseFixLock');
    logSuccess(result.message);
    
  } catch (error) {
    logError('Erro ao liberar lock');
    process.exit(1);
  }
}

// Mostrar ajuda
function showHelp() {
  console.log(`
${colors.bright}Corretor de Artigos - Script de Execução Local${colors.reset}

${colors.cyan}Uso:${colors.reset}
  node scripts/fix-articles.js [opção]

${colors.cyan}Opções:${colors.reset}
  --all                    Corrigir todas as empresas
  --company ID_DA_EMPRESA  Corrigir empresa específica
  --status                 Verificar se há correção em andamento
  --release-lock           Liberar lock manualmente
  --help                   Mostrar esta ajuda

${colors.cyan}Exemplos:${colors.reset}
  node scripts/fix-articles.js --all
  node scripts/fix-articles.js --company empresa123
  node scripts/fix-articles.js --status
  node scripts/fix-articles.js --release-lock

${colors.cyan}Notas:${colors.reset}
  - Requer arquivo service-account.json na pasta news-robot/
  - O processo pode demorar vários minutos
  - Acompanhe os logs para monitorar o progresso
`);
}

// Função principal
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    showHelp();
    return;
  }
  
  try {
    if (args.includes('--all')) {
      await fixAllCompanies();
    } else if (args.includes('--company')) {
      const companyIndex = args.indexOf('--company');
      const companyId = args[companyIndex + 1];
      
      if (!companyId) {
        logError('ID da empresa não fornecido');
        logInfo('Uso: node scripts/fix-articles.js --company ID_DA_EMPRESA');
        process.exit(1);
      }
      
      await fixCompany(companyId);
    } else if (args.includes('--status')) {
      await checkStatus();
    } else if (args.includes('--release-lock')) {
      await releaseLock();
    } else {
      logError('Opção inválida');
      showHelp();
      process.exit(1);
    }
    
    logSuccess('\nScript concluído com sucesso!');
    
  } catch (error) {
    logError(`Erro inesperado: ${error.message}`);
    process.exit(1);
  }
}

// Executar script
if (require.main === module) {
  main().catch(error => {
    logError(`Erro fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  fixAllCompanies,
  fixCompany,
  checkStatus,
  releaseLock
};