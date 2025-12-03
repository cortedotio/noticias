#!/usr/bin/env node

/**
 * Script de demonstração da correção de artigos
 * 
 * Este script demonstra como a correção funciona sem precisar de credenciais do Firebase
 */

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

// Função para extrair domínio da URL (mesma lógica usada nas funções Firebase)
function extractDomainFromUrl(url) {
  try {
    // Remove protocolo e www
    let domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    
    // Pega apenas o domínio principal e subdomínio
    const parts = domain.split('/')[0].split('.');
    if (parts.length >= 2) {
      // Mantém domínio e subdomínio (ex: g1.globo.com)
      domain = parts.slice(0, -1).join('.');
    }
    
    return domain;
  } catch (error) {
    console.error('Erro ao extrair domínio:', error);
    return 'desconhecido';
  }
}

// Função de correção de artigo (mesma lógica usada nas funções Firebase)
function correctArticle(article) {
  const updated = { ...article };
  let wasUpdated = false;
  
  // Verificar se é YouTube
  const isYouTube = article.url && (
    article.url.includes('youtube.com') || 
    article.url.includes('youtu.be')
  );
  
  if (isYouTube) {
    // Para YouTube: fonte = "Canal", autor = "Redação*"
    if (updated.source && updated.source.name !== 'Canal') {
      updated.source = { ...updated.source, name: 'Canal' };
      wasUpdated = true;
    }
    
    if (!updated.author || updated.author === 'desconhecido') {
      updated.author = 'Redação*';
      wasUpdated = true;
    }
  } else {
    // Para outras fontes: usar domínio como nome da fonte
    if (updated.url && updated.source) {
      const domain = extractDomainFromUrl(updated.url);
      if (updated.source.name !== domain) {
        updated.source = { ...updated.source, name: domain };
        wasUpdated = true;
      }
    }
  }
  
  return { updated, wasUpdated };
}

// Demonstração da correção
function demonstrateCorrection() {
  logProgress('=== DEMONSTRAÇÃO DA CORREÇÃO DE ARTIGOS ===\n');
  
  // Artigos de exemplo
  const sampleArticles = [
    {
      id: '1',
      title: 'Vídeo: Novo lançamento tecnológico',
      url: 'https://www.youtube.com/watch?v=abc123',
      source: { name: 'YouTube' },
      author: 'Tech Channel'
    },
    {
      id: '2',
      title: 'Vídeo: Tutorial de programação',
      url: 'https://youtu.be/xyz789',
      source: { name: 'YouTube' },
      author: 'desconhecido'
    },
    {
      id: '3',
      title: 'Notícia: Economia em alta',
      url: 'https://g1.globo.com/economia/noticia/2024/11/15/economia-em-alta.ghtml',
      source: { name: 'G1' },
      author: 'Redação G1'
    },
    {
      id: '4',
      title: 'Artigo: Tecnologia e sociedade',
      url: 'https://www.techtudo.com.br/artigo/tecnologia-sociedade.htm',
      source: { name: 'TechTudo' },
      author: 'João Silva'
    }
  ];
  
  logInfo('Artigos antes da correção:');
  sampleArticles.forEach(article => {
    log(`  "${article.title}"`);
    log(`  URL: ${article.url}`);
    log(`  Fonte: ${article.source.name} | Autor: ${article.author}\n`);
  });
  
  logProgress('Aplicando correções...\n');
  
  // Aplicar correções
  const results = sampleArticles.map(article => {
    const { updated, wasUpdated } = correctArticle(article);
    return {
      original: article,
      updated,
      wasUpdated
    };
  });
  
  logSuccess('Artigos após a correção:');
  results.forEach(result => {
    const { original, updated, wasUpdated } = result;
    
    log(`  "${updated.title}"`);
    log(`  URL: ${updated.url}`);
    log(`  Fonte: ${updated.source.name} | Autor: ${updated.author}`);
    
    if (wasUpdated) {
      logSuccess('  ✅ CORRIGIDO');
    } else {
      logInfo('  ℹ️  SEM ALTERAÇÕES');
    }
    log('');
  });
  
  // Estatísticas
  const totalUpdated = results.filter(r => r.wasUpdated).length;
  logSuccess(`Resumo da correção:`);
  logInfo(`  Total de artigos: ${sampleArticles.length}`);
  logInfo(`  Artigos corrigidos: ${totalUpdated}`);
  logInfo(`  Artigos sem alterações: ${sampleArticles.length - totalUpdated}`);
  
  // Demonstrar extração de domínio
  logProgress('\n=== EXTRAÇÃO DE DOMÍNIO ===');
  const testUrls = [
    'https://g1.globo.com/economia/noticia/teste.html',
    'https://www.techtudo.com.br/artigo/teste',
    'https://youtube.com/watch?v=abc123',
    'https://www.uol.com.br/noticias/'
  ];
  
  testUrls.forEach(url => {
    const domain = extractDomainFromUrl(url);
    logInfo(`  ${url} → ${domain}`);
  });
}

// Função principal
function main() {
  demonstrateCorrection();
  
  logProgress('\n=== INSTRUÇÕES PARA USO REAL ===');
  logInfo('Para corrigir artigos reais, use:');
  log('  node scripts/fix-articles.js --all');
  log('  node scripts/fix-articles.js --company ID_DA_EMPRESA');
  log('  node scripts/fix-articles.js --status');
  log('  node scripts/fix-articles.js --release-lock');
  
  logWarning('\n⚠️  IMPORTANTE:');
  logInfo('  - Requer arquivo service-account.json na pasta news-robot/');
  logInfo('  - O processo pode demorar vários minutos');
  logInfo('  - Acompanhe os logs para monitorar o progresso');
  
  logSuccess('\nDemonstração concluída!');
}

// Executar demonstração
if (require.main === module) {
  main();
}