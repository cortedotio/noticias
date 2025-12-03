#!/usr/bin/env node

/**
 * Executador de correção real de artigos
 * 
 * Este script executa a correção real através das funções Firebase
 * sem necessidade do service-account.json
 */

const https = require('https');
const http = require('http');

// Configuração do Firebase (já existente no projeto)
const firebaseConfig = {
  apiKey: "AIzaSyD0uG7bXj3qJ3bXj3qJ3bXj3qJ3bXj3qJ3b",
  authDomain: "noticias-6e952.firebaseapp.com",
  projectId: "noticias-6e952",
  storageBucket: "noticias-6e952.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

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
  console.log('\n' + '═'.repeat(70));
  log('🛠️  EXECUTOR DE CORREÇÃO REAL DE ARTIGOS', 'cyan');
  console.log('═'.repeat(70));
}

// Função para chamar a função Firebase via HTTP
async function callFirebaseFunction(functionName, data = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'us-central1-noticias-6e952.cloudfunctions.net',
      port: 443,
      path: `/${functionName}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(result);
          } else {
            reject(new Error(`Erro ${res.statusCode}: ${result.error || data}`));
          }
        } catch (e) {
          reject(new Error(`Erro ao processar resposta: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Função principal de correção
async function executeRealCorrection() {
  showBanner();
  logInfo(`Conectando ao Firebase: ${firebaseConfig.projectId}`);
  logInfo('Preparando correção de TODOS os artigos de TODAS as empresas...\n');

  try {
    logInfo('📞 Chamando função fixAllCompaniesArticles...');
    
    // Chamar a função Firebase
    const result = await callFirebaseFunction('fixAllCompaniesArticles', {
      timestamp: new Date().toISOString(),
      user: 'admin-correction-script'
    });

    logSuccess('✅ Correção executada com sucesso!');
    
    // Processar e exibir resultados
    if (result && result.data) {
      displayResults(result.data);
    } else {
      logWarning('Resposta inesperada do servidor:');
      console.log(result);
    }

  } catch (error) {
    logError(`Erro durante a correção: ${error.message}`);
    
    // Tentar fallback para função alternativa
    logInfo('\n🔄 Tentando função alternativa fixExistingArticles...');
    
    try {
      const fallbackResult = await callFirebaseFunction('fixExistingArticles', {
        timestamp: new Date().toISOString(),
        user: 'admin-correction-script'
      });
      
      logSuccess('✅ Correção alternativa executada com sucesso!');
      displayResults(fallbackResult.data);
      
    } catch (fallbackError) {
      logError(`Erro na função alternativa: ${fallbackError.message}`);
      logInfo('\n💡 Alternativas disponíveis:');
      logInfo('1. Acesse: http://localhost:8001/executar-correcao-cliente.html');
      logInfo('2. Verifique se as funções estão deployadas no Firebase');
      logInfo('3. Use o painel Super Admin na interface web principal');
    }
  }
}

function displayResults(data) {
  console.log('\n' + '═'.repeat(50));
  log('📊 RELATÓRIO DE CORREÇÃO', 'cyan');
  console.log('═'.repeat(50));
  
  if (data.companies) {
    logInfo(`📋 Empresas processadas: ${data.companies.length}`);
    
    let totalArticles = 0;
    let totalFixed = 0;
    
    data.companies.forEach(company => {
      const fixed = company.articlesFixed || 0;
      const total = company.totalArticles || 0;
      totalArticles += total;
      totalFixed += fixed;
      
      log(`• ${company.name}: ${fixed} de ${total} artigos corrigidos`);
    });
    
    console.log('\n' + '─'.repeat(30));
    logSuccess(`📄 Total de artigos: ${totalArticles}`);
    logSuccess(`✏️  Artigos corrigidos: ${totalFixed}`);
    
    if (data.executionTime) {
      logInfo(`⏱️  Tempo de execução: ${data.executionTime}s`);
    }
    
    if (data.errors && data.errors.length > 0) {
      logWarning(`⚠️  Erros encontrados: ${data.errors.length}`);
      data.errors.forEach(error => {
        log(`  • ${error}`);
      });
    }
  }
  
  console.log('═'.repeat(50) + '\n');
}

// Executar se chamado diretamente
if (require.main === module) {
  executeRealCorrection().catch(error => {
    logError(`Erro fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { executeRealCorrection, callFirebaseFunction };