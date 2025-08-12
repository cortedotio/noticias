import axios from "axios"; // se estiver usando ES Modules
// const axios = require("axios"); // se estiver usando CommonJS

async function pegarDados() {
  const resposta = await axios.get("https://api.github.com/zen");
  console.log(resposta.data);
}

pegarDados();
