const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  'https://growito-n8n-d85d21478a6e.herokuapp.com/webhook/bt-resposta-whatsapp';

// Local no Windows:
// depois, no Render com disco persistente, você troca via variável de ambiente para /data/auth
const AUTH_DIR = process.env.AUTH_DIR || './auth';

let sock;
let latestQr = null;
let isReady = false;
let isStarting = false;

function getTextFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log('Iniciando Baileys...');
    console.log('AUTH_DIR:', AUTH_DIR);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'info' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      browser: ['Windows', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          latestQr = await QRCode.toDataURL(qr);
          console.log(`QR gerado. Abra: http://localhost:${PORT}/qr`);
        }

        if (connection === 'open') {
          isReady = true;
          latestQr = null;
          console.log('✅ Conectado ao WhatsApp');
        }

        if (connection === 'close') {
          isReady = false;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log('❌ Conexão fechada. Status:', statusCode);
          console.log('Motivo completo:', lastDisconnect?.error);

          if (shouldReconnect) {
            console.log('Tentando reconectar em 5 segundos...');
            setTimeout(() => {
              startBot().catch((err) => {
                console.error('Erro ao reiniciar bot:', err?.message || err);
              });
            }, 5000);
          } else {
            console.log('Sessão deslogada. Será necessário escanear novo QR.');
          }
        }
      } catch (error) {
        console.error('Erro em connection.update:', error?.message || error);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message) return;
        if (msg.key.fromMe) return;

        const text = getTextFromMessage(msg);
        if (!text) return;

        const remoteJid = msg.key.remoteJid || '';
        const messageType = Object.keys(msg.message || {})[0] || 'unknown';

        console.log('📩 Mensagem recebida:', text);
        console.log('De:', remoteJid);
        console.log('Tipo:', messageType);

        const payload = {
          event: 'messages.upsert',
          instance: 'baitatrampo-baileys',
          data: {
            key: {
              remoteJid,
              fromMe: false,
            },
            message: {
              conversation: text,
            },
            messageType,
            messageTimestamp:
              Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
          },
          sender: remoteJid,
          source: 'baileys',
          upsertType: type,
        };

        await axios.post(N8N_WEBHOOK_URL, payload, {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

        console.log('✅ Payload enviado ao n8n com sucesso');
      } catch (error) {
        console.error(
          'Erro ao processar messages.upsert:',
          error?.response?.data || error?.message || error
        );
      }
    });
  } catch (error) {
    console.error('Erro ao iniciar o Baileys:', error?.message || error);
  } finally {
    isStarting = false;
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ready: isReady,
    hasQr: Boolean(latestQr),
    authDir: AUTH_DIR,
  });
});

app.get('/qr', (req, res) => {
  if (!latestQr) {
    return res.status(404).send(`
      <html>
        <body style="font-family: Arial; padding: 24px;">
          <h2>QR não disponível no momento</h2>
          <p>Se a sessão já estiver conectada, isso é normal.</p>
          <p>Confira também o endpoint <strong>/health</strong>.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <body style="font-family: Arial; padding: 24px;">
        <h2>QR Code do WhatsApp</h2>
        <p>Escaneie com o WhatsApp em <strong>Dispositivos conectados</strong>.</p>
        <img src="${latestQr}" alt="QR Code" />
      </body>
    </html>
  `);
});

app.post('/send', async (req, res) => {
  try {
    const { number, text } = req.body;

    if (!number || !text) {
      return res.status(400).json({
        ok: false,
        message: 'number e text são obrigatórios.',
      });
    }

    if (!sock || !isReady) {
      return res.status(503).json({
        ok: false,
        message: 'WhatsApp ainda não está conectado.',
      });
    }

    const jid = `${String(number).replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });

    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || 'Erro ao enviar mensagem.',
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`QR: http://localhost:${PORT}/qr`);
  await startBot();
});