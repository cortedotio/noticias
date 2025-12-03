### Scripts de Correção de Artigos

Este diretório contém scripts para correção de artigos já capturados.

### Script de Demonstração

Antes de executar a correção real, você pode testar a lógica com o script de demonstração:

```bash
node scripts/demo-fix-articles.js
```

Este script mostra como a correção funciona com artigos de exemplo, sem precisar de credenciais do Firebase.no sistema.

## 📋 Pré-requisitos

1. **Node.js** instalado (versão 14 ou superior)
2. **Arquivo de credenciais do Firebase** (`service-account.json`)

### Obter o arquivo de credenciais:

1. Acesse: https://console.firebase.google.com/project/noticias-6e952/settings/serviceaccounts/adminsdk
2. Clique em "Gerar nova chave privada"
3. Salve o arquivo como `service-account.json`
4. Mova o arquivo para a pasta `news-robot/`

## 🚀 Como usar

### Corrigir TODAS as empresas
```bash
node scripts/fix-articles.js --all
```

### Corrigir empresa específica
```bash
node scripts/fix-articles.js --company ID_DA_EMPRESA
```

### Verificar status da correção
```bash
node scripts/fix-articles.js --status
```

### Liberar lock (se travado)
```bash
node scripts/fix-articles.js --release-lock
```

### Ver ajuda
```bash
node scripts/fix-articles.js --help
```

## 🔒 Segurança

- **Proteção contra execução simultânea**: Apenas uma correção pode ser executada por vez
- **Autenticação obrigatória**: Requer credenciais válidas do Firebase
- **Logs detalhados**: Todos os passos são registrados para auditoria

## 📊 O que é corrigido

### Artigos do YouTube
- **Fonte**: Alterado para "Canal"
- **Autor**: Alterado para "Redação*" (se não identificado)

### Outras fontes
- **Fonte**: Alterado para o domínio da URL (ex: "g1.globo.com")
- **Autor**: Mantém o valor original

## ⏱️ Tempo de execução

O tempo varia conforme a quantidade de artigos:
- Pequenas empresas (até 1.000 artigos): ~1-2 minutos
- Médias empresas (1.000-10.000 artigos): ~5-10 minutos
- Grandes empresas (10.000+ artigos): ~15-30 minutos
- Todas as empresas: pode levar 1+ hora

## 📝 Exemplos de saída

### Correção bem-sucedida:
```
✅ Correção concluída com sucesso!
ℹ️  Total de empresas: 5
ℹ️  Total de artigos processados: 1250
ℹ️  Total de artigos atualizados: 847

Detalhes por empresa:
✅  Empresa A: 234 de 456 artigos
✅  Empresa B: 156 de 234 artigos
✅  Empresa C: 457 de 560 artigos
```

### Status em andamento:
```
⚠️  Correção em andamento!
ℹ️  Iniciado em: 15/11/2024 14:30:25
ℹ️  Tempo decorrido: 12 minutos
⚠️  Aguarde a conclusão antes de iniciar uma nova correção
```

## 🚨 Tratamento de erros

### Erro de autenticação:
- Verifique se o arquivo `service-account.json` está na pasta correta
- Confirme que as credenciais são válidas

### Erro de execução simultânea:
- Aguarde a conclusão da correção atual
- Use `--status` para verificar o progresso
- Em caso de travamento, use `--release-lock`

### Erro de empresa não encontrada:
- Verifique se o ID da empresa está correto
- Confirme que a empresa existe no banco de dados

## 📞 Suporte

Em caso de problemas:
1. Verifique os logs detalhados no console
2. Use `--status` para verificar o progresso
3. Consulte a documentação em `INSTRUCOES_CORRECAO_ARTIGOS.md`
4. Libere o lock se necessário com `--release-lock`