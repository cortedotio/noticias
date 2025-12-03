#!/usr/bin/env node

/**
 * Script de demonstração da correção de artigos
 * Este script simula a correção de artigos para demonstrar o processo
 * 
 * Uso:
 *   node scripts/demo-correcao-local.js --all          # Demonstrar correção de todas as empresas
 *   node scripts/demo-correcao-local.js --help       # Mostrar ajuda
 */

// Configuração de demonstração
const demoData = {
  companies: [
    {
      id: 'empresa-1',
      name: 'Empresa Exemplo 1',
      articles: [
        {
          id: 'article-1',
          title: 'Notícia sobre tecnologia',
          url: 'https://www.youtube.com/watch?v=abc123',
          source: 'YouTube',
          author: 'Tech Channel',
          content: 'Conteúdo da notícia...'
        },
        {
          id: 'article-2',
          title: 'Notícia sobre economia',
          url: 'https://g1.globo.com/economia/noticia/2024/01/15/mercado-financeiro.ghtml',
          source: 'g1.globo.com',
          author: 'Redação G1',
          content: 'Conteúdo da notícia...'
        },
        {
          id: 'article-3',
          title: 'Notícia sobre política',
          url: 'https://news.google.com/articles/CBMiK2h0dHBzOi8vd3d3LmV4ZW1wbGUuY29tL25vdGljaWEtcG9saXRpY2EuaHRtbNIBAA?hl=pt-BR&gl=BR&ceid=BR%3Apt-419',
          source: 'news.google.com',
          author: 'Agência de Notícias',
          content: 'Conteúdo da notícia...'
        }
      ]
    },
    {
      id: 'empresa-2',
      name: 'Empresa Exemplo 2',
      articles: [
        {
          id: 'article-4',
          title: 'Vídeo sobre ciência',
          url: 'https://www.youtube.com/watch?v=def456',
          source: 'YouTube',
          author: 'Science Channel',
          content: 'Conteúdo do vídeo...'
        },
        {
          id: 'article-5',
          title: 'Notícia esportiva',
          url: 'https://esporte.ig.com.br/futebol/2024/01/15/jogo-importante.ghtml',
          source: 'esporte.ig.com.br',
          author: 'Redação Esporte',
          content: 'Conteúdo da notícia...'
        }
      ]
    }
  ]
};

// Função de correção de fonte
function fixSource(url, currentSource) {
  // YouTube
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'Canal';
  }
  
  // Outras fontes - extrair domínio
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return currentSource;
  }
}

// Função de correção de autor
function fixAuthor(url, currentAuthor) {
  // YouTube
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'Redação*';
  }
  
  // Manter autor original para outras fontes
  return currentAuthor;
}

// Função principal de correção
async function fixAllCompanies() {
  console.log('🚀 Iniciando correção de artigos (DEMONSTRAÇÃO)');
  console.log('⏳ Este é um processo de demonstração\n');
  
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalFixed = 0;
  const results = [];
  
  // Processar cada empresa
  for (const company of demoData.companies) {
    console.log(`📊 Processando empresa: ${company.name}`);
    
    let companyProcessed = 0;
    let companyFixed = 0;
    const fixedArticles = [];
    
    // Processar cada artigo
    for (const article of company.articles) {
      companyProcessed++;
      totalProcessed++;
      
      const originalSource = article.source;
      const originalAuthor = article.author;
      
      // Aplicar correções
      const newSource = fixSource(article.url, originalSource);
      const newAuthor = fixAuthor(article.url, originalAuthor);
      
      const sourceChanged = newSource !== originalSource;
      const authorChanged = newAuthor !== originalAuthor;
      
      if (sourceChanged || authorChanged) {
        companyFixed++;
        totalFixed++;
        
        fixedArticles.push({
          id: article.id,
          title: article.title,
          url: article.url,
          originalSource,
          newSource,
          originalAuthor,
          newAuthor,
          changes: {
            source: sourceChanged,
            author: authorChanged
          }
        });
        
        console.log(`  ✏️  Artigo: "${article.title}"`);
        if (sourceChanged) {
          console.log(`     Fonte: "${originalSource}" → "${newSource}"`);
        }
        if (authorChanged) {
          console.log(`     Autor: "${originalAuthor}" → "${newAuthor}"`);
        }
        console.log('');
      }
    }
    
    results.push({
      companyName: company.name,
      processed: companyProcessed,
      fixed: companyFixed,
      success: true,
      message: `${companyFixed} de ${companyProcessed} artigos corrigidos`
    });
    
    console.log(`✅ ${company.name}: ${companyFixed} de ${companyProcessed} artigos corrigidos\n`);
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Relatório final
  console.log('📋 RELATÓRIO DE CORREÇÃO');
  console.log('═'.repeat(50));
  console.log(`📊 Total de empresas processadas: ${demoData.companies.length}`);
  console.log(`📄 Total de artigos processados: ${totalProcessed}`);
  console.log(`✏️  Total de artigos corrigidos: ${totalFixed}`);
  console.log(`⏱️  Tempo de execução: ${duration}s`);
  console.log('═'.repeat(50));
  
  // Detalhes por empresa
  console.log('\n📈 Detalhes por empresa:');
  results.forEach(result => {
    console.log(`• ${result.companyName}: ${result.message}`);
  });
  
  // Exemplos de correções aplicadas
  console.log('\n📝 Exemplos de correções aplicadas:');
  console.log('• YouTube: Fonte → "Canal", Autor → "Redação*"');
  console.log('• g1.globo.com: Fonte mantida como domínio');
  console.log('• news.google.com: Fonte mantida como domínio');
  console.log('• esporte.ig.com.br: Fonte mantida como domínio');
  
  console.log('\n✅ Correção de demonstração concluída com sucesso!');
  console.log('\n💡 Nota: Este foi um processo de demonstração.');
  console.log('   Para executar a correção real, use:');
  console.log('   - Interface web: http://localhost:8001/executar-correcao-cliente.html');
  console.log('   - Script com service account: node scripts/fix-articles.js --all');
  
  return {
    success: true,
    totalCompanies: demoData.companies.length,
    totalProcessed,
    totalFixed,
    duration: `${duration}s`,
    results,
    message: `Correção concluída: ${totalFixed} de ${totalProcessed} artigos corrigidos`
  };
}

// Função de ajuda
function showHelp() {
  console.log('🛠️  Script de Demonstração - Correção de Artigos');
  console.log('═'.repeat(50));
  console.log('Uso:');
  console.log('  node scripts/demo-correcao-local.js --all     # Executar demonstração completa');
  console.log('  node scripts/demo-correcao-local.js --help    # Mostrar esta ajuda');
  console.log('');
  console.log('💡 Para correção real:');
  console.log('  1. Obtenha o arquivo service-account.json do Firebase Console');
  console.log('  2. Use: node scripts/fix-articles.js --all');
  console.log('  3. Ou use a interface web: http://localhost:8001/executar-correcao-cliente.html');
}

// Função principal
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  if (args.includes('--all')) {
    try {
      const resultado = await fixAllCompanies();
      process.exit(0);
    } catch (error) {
      console.error('❌ Erro durante a demonstração:', error.message);
      process.exit(1);
    }
    return;
  }
  
  console.log('⚠️  Comando não reconhecido. Use --help para ver as opções.');
  process.exit(1);
}

// Executar se chamado diretamente
if (require.main === module) {
  main();
}

module.exports = { fixAllCompanies, showHelp };