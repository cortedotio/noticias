# Instruções para Correção de Artigos já Capturados

## Visão Geral

Foram implementadas funções Firebase para corrigir os nomes das fontes e canais de todos os artigos já capturados no banco de dados. As correções seguem as novas regras:

- **YouTube**: Fonte = "Canal", Autor = "Redação*" (quando não houver canal definido)
- **Outras fontes**: Fonte = domínio da URL (ex: g1.globo.com, news.google.com)

## Funções Disponíveis

### 1. `fixAllCompaniesArticles`
**Descrição**: Corrige artigos de TODAS as empresas de uma vez.

**Como usar**:
```javascript
// No Firebase Cloud Functions
const result = await exports.fixAllCompaniesArticles({}, context);

// Ou via HTTP request (se exposto como endpoint)
const response = await fetch('https://your-project.cloudfunctions.net/fixAllCompaniesArticles', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({})
});
```

**Retorno**:
```json
{
  "success": true,
  "totalCompanies": 15,
  "totalProcessed": 1250,
  "totalUpdated": 1180,
  "results": [
    {
      "companyId": "empresa1",
      "companyName": "Empresa Exemplo",
      "success": true,
      "processed": 100,
      "updated": 95,
      "errors": 0,
      "message": "Correção concluída: 95 artigos atualizados de 100 processados"
    }
  ],
  "message": "Correção geral concluída: 1180 artigos atualizados em 15 empresas",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. `fixExistingArticles`
**Descrição**: Corrige artigos de uma empresa específica.

**Como usar**:
```javascript
// Para uma empresa específica
const result = await exports.fixExistingArticles({ 
  companyId: "ID_DA_EMPRESA" 
}, context);
```

**Retorno**:
```json
{
  "success": true,
  "processed": 100,
  "updated": 95,
  "errors": 0,
  "message": "Correção concluída: 95 artigos atualizados de 100 processados"
}
```

### 3. `checkFixStatus`
**Descrição**: Verifica se há uma correção em andamento.

**Como usar**:
```javascript
const status = await exports.checkFixStatus({}, context);
```

**Retorno**:
```json
{
  "running": true,
  "startedAt": "2024-01-15T10:00:00.000Z",
  "minutesRunning": 30,
  "message": "Processo em execução"
}
```

### 4. `releaseFixLock`
**Descrição**: Libera o lock manualmente (em caso de falha ou necessidade).

**Como usar**:
```javascript
const result = await exports.releaseFixLock({}, context);
```

**Retorno**:
```json
{
  "success": true,
  "message": "Lock liberado com sucesso"
}
```

## Segurança e Controle

### Proteção contra Execução Simultânea
- **Lock automático**: Impede múltiplas execuções simultâneas
- **Duração máxima**: 30 minutos (lock expira automaticamente)
- **Verificação**: Sempre verifica se há execução em andamento antes de iniciar

### Autenticação
- **Obrigatória**: Todas as funções requerem autenticação Firebase
- **Erro**: Retorna `unauthenticated` se o usuário não estiver logado

### Logs e Monitoramento
- **Logs detalhados**: Todas as operações são registradas no Firebase Functions
- **Progresso**: Logs a cada 100 artigos processados
- **Erros**: Todos os erros são capturados e registrados

## Exemplos de Uso

### Exemplo 1: Correção Geral
```javascript
try {
  // Verificar se há processo em andamento
  const status = await exports.checkFixStatus({}, context);
  
  if (status.running) {
    console.log(`Correção já em andamento há ${status.minutesRunning} minutos`);
  } else {
    // Executar correção para todas as empresas
    const result = await exports.fixAllCompaniesArticles({}, context);
    console.log(`Correção concluída: ${result.totalUpdated} artigos atualizados`);
  }
} catch (error) {
  console.error('Erro na correção:', error.message);
}
```

### Exemplo 2: Correção por Empresa
```javascript
// Corrigir artigos de uma empresa específica
const companyId = "empresa123";
const result = await exports.fixExistingArticles({ companyId }, context);
console.log(`Empresa ${companyId}: ${result.updated} artigos corrigidos`);
```

### Exemplo 3: Liberar Lock Manualmente
```javascript
// Se necessário liberar o lock (ex: após falha)
try {
  await exports.releaseFixLock({}, context);
  console.log('Lock liberado com sucesso');
} catch (error) {
  console.error('Erro ao liberar lock:', error.message);
}
```

## Configurações Técnicas

### Processamento em Lotes
- **Tamanho do lote**: 500 artigos por vez
- **Commit automático**: A cada lote completo
- **Memória**: 1GB alocada para processamento
- **Timeout**: 9 minutos máximo (540 segundos)

### Estrutura dos Dados
Os artigos são corrigidos na coleção:
```
artifacts/{APP_ID}/public/data/pendingAlerts
```

Cada artigo tem a estrutura:
```javascript
{
  url: "string",           // URL do artigo
  source: {
    name: "string"         // Nome da fonte (será corrigido)
  },
  author: "string",        // Autor (será corrigido para YouTube)
  companyId: "string",     // ID da empresa
  // ... outros campos
}
```

## Tratamento de Erros

### Erros Comuns
1. **`unauthenticated`**: Usuário não autenticado
2. **`already-exists`**: Já existe correção em andamento
3. **`internal`**: Erro interno do servidor

### Exemplo de Tratamento
```javascript
try {
  const result = await exports.fixAllCompaniesArticles({}, context);
} catch (error) {
  switch (error.code) {
    case 'unauthenticated':
      console.error('Usuário não autenticado');
      break;
    case 'already-exists':
      console.error('Já existe correção em andamento');
      break;
    case 'internal':
      console.error('Erro interno:', error.message);
      break;
    default:
      console.error('Erro desconhecido:', error.message);
  }
}
```

## Notas Importantes

1. **Backup**: Recomenda-se fazer backup dos dados antes de executar
2. **Teste**: Testar em uma empresa primeiro antes de executar em todas
3. **Monitoramento**: Acompanhar os logs durante a execução
4. **Tempo**: O processo pode demorar vários minutos dependendo da quantidade de artigos
5. **Reversão**: As alterações são permanentes - não há reversão automática

## Suporte

Para problemas ou dúvidas:
1. Verifique os logs do Firebase Functions
2. Use a função `checkFixStatus` para verificar status
3. Em caso de lock travado, use `releaseFixLock` para liberar
4. Monitore o progresso através dos logs detalhados