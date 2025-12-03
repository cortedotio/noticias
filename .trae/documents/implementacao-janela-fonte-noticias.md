# Documentação Técnica - Implementação de Janela de Tempo e Identificação de Fonte

## Visão Geral

Este documento descreve a implementação de duas funcionalidades na página "Fontes de Notícias Globais":

1. **Janela permitida para buscar notícias**: Restringir a busca de notícias a um período específico (início e fim)
2. **Identificação de Fonte por Domínio**: Usar o nome do domínio como fonte, não o nome dos autores

## Análise do Código Atual

### 1. Função `fetchAllNews` (news-robot/index.js)

A função principal de busca de notícias está localizada nas linhas 311-400. Atualmente:
- Busca notícias de várias fontes (GNews, NewsAPI, RSS, YouTube)
- Processa artigos sem verificação de janela de tempo
- Normaliza artigos usando a função `normalizeArticle`

### 2. Função `normalizeArticle` (news-robot/index.js)

Localizada nas linhas 215-280, esta função:
- Processa artigos de diferentes APIs (gnews, newsapi, blogger, rss, youtube)
- Define o nome da fonte baseado no que vem da API
- Para RSS, já usa o hostname como fallback

### 3. Função `isWithinWindow` (server/index.js)

Localizada nas linhas 475-490, esta função:
- Verifica se uma data está dentro de um intervalo de tempo
- Suporta janelas overnight (quando fim < início)
- Já está implementada e testada

## Implementação da Janela de Tempo

### Passo 1: Adicionar Verificação de Janela em `fetchAllNews`

```javascript
// Adicionar após a definição de allCompaniesData (linha ~430)
for (const company of allCompaniesData) {
    functions.logger.info(`--- Processando empresa: ${company.companyName} ---`);
    
    // NOVO: Verificar se está dentro da janela permitida
    if (!isWithinWindow(settings.newsWindowStart, settings.newsWindowEnd)) {
        functions.logger.info(`Fora da janela permitida (${settings.newsWindowStart} - ${settings.newsWindowEnd}), pulando empresa ${company.companyName}`);
        continue;
    }
    
    const combinedQuery = company.keywordsList.map(kw => `"${kw}"`).join(" OR ");
    // ... resto do código existente
}
```

### Passo 2: Importar a Função `isWithinWindow`

```javascript
// Adicionar no início do arquivo news-robot/index.js
const { isWithinWindow } = require('../server/index.js');
```

## Implementação da Identificação de Fonte por Domínio

### Modificar `normalizeArticle` para Priorizar Domínio

```javascript
// Modificar o case 'gnews' (linha ~218)
case 'gnews': 
    const domainName = article.source?.url ? new URL(article.source.url).hostname.replace(/^www\./, '') : article.source.name;
    return { 
        title: article.title, 
        description: article.description, 
        url: article.url, 
        image: article.image || null, 
        publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), 
        source: { name: domainName, url: article.source.url }, 
        author: article.author || null, 
    };

// Modificar o case 'newsapi' (linha ~219)
case 'newsapi': 
    const domainName = article.url ? new URL(article.url).hostname.replace(/^www\./, '') : article.source.name;
    return { 
        title: article.title, 
        description: article.description, 
        url: article.url, 
        image: article.urlToImage || null, 
        publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), 
        source: { name: domainName, url: null }, 
        author: article.author || null, 
    };

// Modificar o case 'youtube' (linha ~235)
case 'youtube': 
    const channelUrl = `https://www.youtube.com/channel/${article.snippet.channelId}`;
    return { 
        title: article.snippet.title, 
        description: article.snippet.description, 
        url: `https://www.youtube.com/watch?v=${article.id.videoId}`, 
        image: article.snippet.thumbnails.high.url || null, 
        publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.snippet.publishedAt)), 
        source: { name: 'YouTube', url: channelUrl }, 
        author: article.snippet.channelTitle || null, 
        videoId: article.id.videoId 
    };
```

## Configurações Necessárias

### Adicionar Campos de Configuração

As configurações `newsWindowStart` e `newsWindowEnd` já existem no Firestore (observado nas linhas 2400-2420 do public/index.html). Certificar-se de que:
- Os campos estão disponíveis nas configurações globais
- Os valores estão no formato HH:MM (24 horas)

## Testes Recomendados

### 1. Teste de Janela de Tempo

```javascript
// Testar a função isWithinWindow
console.log('Teste 1:', isWithinWindow('08:00', '18:00', new Date(2024, 0, 1, 12, 0))); // true
console.log('Teste 2:', isWithinWindow('08:00', '18:00', new Date(2024, 0, 1, 7, 0)));  // false
console.log('Teste 3:', isWithinWindow('22:00', '06:00', new Date(2024, 0, 1, 23, 0))); // true (overnight)
```

### 2. Teste de Identificação de Fonte

```javascript
// Testar a extração de domínio
const testUrls = [
    'https://www.example.com/news/article',
    'https://subdomain.site.com.br/path',
    'https://g1.globo.com/economia/noticia'
];

testUrls.forEach(url => {
    const domain = new URL(url).hostname.replace(/^www\./, '');
    console.log(`${url} -> ${domain}`);
});
```

### 3. Teste de Integração

1. Configurar uma janela de tempo curta (ex: 10 minutos)
2. Executar o fetchAllNews dentro e fora da janela
3. Verificar os logs para confirmar o comportamento
4. Verificar os artigos salvos para confirmar a fonte correta

## Considerações de Performance

- A verificação de janela deve ser feita antes de processar cada empresa
- A extração de domínio é rápida mas pode ser otimizada com cache se necessário
- Manter os logs para monitoramento do comportamento

## Manutenção

- Monitorar logs para identificar problemas de janela de tempo
- Verificar se a identificação de fonte está correta para novos sites
- Ajustar a lógica se surgirem casos edge (ex: URLs malformadas)