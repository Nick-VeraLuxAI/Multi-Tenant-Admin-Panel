// scripts/encrypt-tenant-secrets.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { encrypt, isEncrypted, hasKey } = require('../utils/kms');
const prisma = new PrismaClient();

(async () => {
  if (!hasKey()) throw new Error('KMS_MASTER_KEY required');
  const tenants = await prisma.tenant.findMany({
    select: {
      id: true, name: true,
      smtpPass: true, openaiKey: true,
      googleClientSecret: true, googleTokens: true
    }
  });

  for (const t of tenants) {
    const data = {};
    if (t.smtpPass && !isEncrypted(t.smtpPass)) data.smtpPass = encrypt(t.smtpPass);
    if (t.openaiKey && !isEncrypted(t.openaiKey)) data.openaiKey = encrypt(t.openaiKey);
    if (t.googleClientSecret && !isEncrypted(t.googleClientSecret)) data.googleClientSecret = encrypt(t.googleClientSecret);

    if (t.googleTokens && typeof t.googleTokens !== 'string') {
      data.googleTokens = encrypt(JSON.stringify(t.googleTokens));
    } else if (t.googleTokens && typeof t.googleTokens === 'string' && !isEncrypted(t.googleTokens)) {
      data.googleTokens = encrypt(t.googleTokens);
    }

    if (Object.keys(data).length) {
      await prisma.tenant.update({ where: { id: t.id }, data });
      console.log(`Encrypted secrets for tenant ${t.name} (${t.id})`);
    }
  }
  await prisma.$disconnect();
  console.log('Done.');
})().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
