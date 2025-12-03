#!/usr/bin/env node

/**
 * Executador de correção de artigos
 * 
 * Este script facilita a execução da correção de artigos
 * 
 * Uso:
 *   node scripts/executar-correcao.js --help    # Mostrar ajuda
 *   node scripts/executar-correcao.js --demo     # Executar demonstração
 *   node scripts/executar-correcao.js --real     # Executar correção real (requer service-account.json)
 */

const { execSync } = require('child_process');
const fs = require('fs');
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

function showBanner() {
  console.log('\n' + '═'.repeat(60));
  log('🛠️  EXECUTOR DE CORREÇÃO DE ARTIGOS', 'cyan');
  console.log('═'.repeat(60));
}

function showHelp() {
  showBanner();
  console.log('\n📋 OPÇÕES DISPONÍVEIS:\n');
  
  logInfo('1. DEMONSTRAÇÃO (Sem necessidade de configuração)');
  console.log('   node scripts/executar-correcao.js --demo');
  console.log('   → Executa uma simulação completa do processo de correção\n');
  
  logInfo('2. CORREÇÃO REAL (Requer service-account.json)');
  console.log('   node scripts/executar-correcao.js --real');
  console.log('   → Executa a correção real no banco de dados\n');
  
  logInfo('3. INTERFACE WEB (Recomendado)');
  console.log('   Acesse: http://localhost:8001/executar-correcao-cliente.html');
  console.log('   → Interface gráfica completa para correção\n');
  
  logInfo('4. AJUDA');
  console.log('   node scripts/executar-correcao.js --help');
  console.log('   → Mostra esta mensagem de ajuda\n');
  
  console.log('═'.repeat(60));
  log('📖 DOCUMENTAÇÃO:', 'cyan');
  console.log('• Verifique RELATORIO_CORRECAO_ARTIGOS.md para detalhes completos');
  console.log('• As regras de correção são:');
  console.log('  - YouTube: Fonte → "Canal", Autor → "Redação*"');
  console.log('  - Outras fontes: Fonte mantida como domínio da URL');
  console.log('═'.repeat(60) + '\n');
}

function checkServiceAccount() {
  const serviceAccountPath = path.join(__dirname, '../news-robot/service-account.json');
  return fs.existsSync(serviceAccountPath);
}

function runDemo() {
  showBanner();
  logInfo('Iniciando demonstração da correção de artigos...\n');
  
  try {
    execSync('node scripts/demo-correcao-local.js --all', { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    
    logSuccess('\n✅ Demonstração concluída com sucesso!');
    logInfo('\n💡 Para executar a correção real, você precisa:');
    logInfo('   1. Obter o arquivo service-account.json do Firebase Console');
    logInfo('   2. Colocá-lo em: news-robot/service-account.json');
    logInfo('   3. Executar: node scripts/executar-correcao.js --real');
    logInfo('\n🌐 Ou use a interface web: http://localhost:8001/executar-correcao-cliente.html');
    
  } catch (error) {
    logError('Erro ao executar demonstração: ' + error.message);
    process.exit(1);
  }
}

function runReal() {
  showBanner();
  
  if (!checkServiceAccount()) {
    logError('Arquivo service-account.json não encontrado!\n');
    logInfo('📋 Para executar a correção real:');
    logInfo('1. Acesse: https://console.firebase.google.com/project/noticias-6e952/settings/serviceaccounts/adminsdk');
    logInfo('2. Clique em "Gerar nova chave privada"');
    logInfo('3. Salve como: service-account.json');
    logInfo('4. Mova para: news-robot/service-account.json');
    logInfo('\n🌐 Alternativa: Use a interface web em http://localhost:8001/executar-correcao-cliente.html');
    process.exit(1);
  }
  
  logInfo('Iniciando correção real de artigos...\n');
  logWarning('⚠️  Esta operação irá modificar os dados no banco de Firebase!');
  
  if (!confirm('Tem certeza que deseja continuar? (s/n): ')) {
    logInfo('Operação cancelada.');
    process.exit(0);
  }
  
  try {
    execSync('node scripts/fix-articles.js --all', { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    
    logSuccess('\n✅ Correção real concluída com sucesso!');
    
  } catch (error) {
    logError('\n❌ Erro durante a correção: ' + error.message);
    process.exit(1);
  }
}

function confirm(message) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 's' || answer.toLowerCase() === 'sim');
    });
  });
}

// Função principal
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    showHelp();
    return;
  }
  
  if (args.includes('--demo')) {
    runDemo();
    return;
  }
  
  if (args.includes('--real')) {
    await runReal();
    return;
  }
  
  logError('Comando não reconhecido.');
  logInfo('Use --help para ver as opções disponíveis.');
  process.exit(1);
}

// Executar se chamado diretamente
if (require.main === module) {
  main().catch(error => {
    logError('Erro fatal: ' + error.message);
    process.exit(1);
  });
}

module.exports = { showHelp, runDemo, runReal };