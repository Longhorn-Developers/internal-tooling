import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite', 
  schema: './src/db/schema.ts', // Adjust this to match where your schema file lives
  out: './drizzle',             // This is where your SQL migrations will be outputted
});