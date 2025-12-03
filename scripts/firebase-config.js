/**
 * Configuração do Firebase Admin SDK
 * 
 * Este arquivo deve ser personalizado com as credenciais do seu projeto
 */

// Adicionar o diretório news-robot ao path para encontrar os módulos
const path = require('path');
const Module = require('module');

// Adicionar news-robot/node_modules ao path de resolução de módulos
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'firebase-admin' || request === 'firebase-functions') {
    try {
      return originalResolveFilename.call(this, request, parent, isMain);
    } catch (e) {
      // Se não encontrar, tentar no diretório news-robot
      const newsRobotPath = path.join(__dirname, '../news-robot/node_modules', request);
      try {
        return originalResolveFilename.call(this, newsRobotPath, parent, isMain);
      } catch (e2) {
        // Se ainda não encontrar, tentar requerer diretamente
        return require.resolve(path.join(__dirname, '../news-robot/node_modules', request));
      }
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain);
};

const admin = require('firebase-admin');

// Configurações do projeto
const PROJECT_ID = 'noticias-6e952';
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '../news-robot/service-account.json');

let app;

function initializeFirebase() {
  if (app) {
    return app;
  }

  try {
    // Verificar se o arquivo de service account existe
    const fs = require('fs');
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      throw new Error(`
Arquivo service-account.json não encontrado!

Por favor, faça o download do arquivo de chave de serviço do Firebase:
1. Acesse: https://console.firebase.google.com/project/${PROJECT_ID}/settings/serviceaccounts/adminsdk
2. Clique em "Gerar nova chave privada"
3. Salve o arquivo como: service-account.json
4. Mova o arquivo para: ${SERVICE_ACCOUNT_PATH}
      `);
    }

    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${PROJECT_ID}.firebaseio.com`,
      storageBucket: `${PROJECT_ID}.appspot.com`
    });

    console.log('✅ Firebase inicializado com sucesso');
    return app;
  } catch (error) {
    console.error('❌ Erro ao inicializar Firebase:', error.message);
    process.exit(1);
  }
}

function getFirestore() {
  if (!app) {
    initializeFirebase();
  }
  return admin.firestore();
}

function getFunctions() {
  if (!app) {
    initializeFirebase();
  }
  return admin.functions();
}

function getStorage() {
  if (!app) {
    initializeFirebase();
  }
  return admin.storage();
}

module.exports = {
  initializeFirebase,
  getFirestore,
  getFunctions,
  getStorage,
  PROJECT_ID
};