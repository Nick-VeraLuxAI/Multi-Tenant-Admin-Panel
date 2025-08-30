// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  // ✅ Create a default tenant (if not exists)
  const tenant = await prisma.tenant.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'Default Tenant',
      apiKey: 'default-api-key',
      plan: 'basic',
      subdomain: 'default'
    }
  });

  // ✅ Hash your password
  const passwordHash = await bcrypt.hash('admin123', 10);

  // ✅ Create an admin user for that tenant
  const admin = await prisma.adminUser.upsert({
    where: {
      tenantId_email: {
        tenantId: tenant.id,
        email: 'admin@example.com'
      }
    },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'admin@example.com',
      passwordHash
    }
  });

  console.log('✅ Seeded tenant and admin user:');
  console.log('Tenant:', tenant);
  console.log('Admin:', admin);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
