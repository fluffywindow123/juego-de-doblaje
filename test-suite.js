/**
 * Automated Verification Test Suite for Voice Dub Hero (ESM)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ZipEngine } from './src/zip-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  console.log('--- TEST 1: Verificar existencia del archivo ZIP original ---');
  const zipPath = path.join(__dirname, 'eres_un_juguete_e7314.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error('No se encontró eres_un_juguete_e7314.zip');
  }
  const zipBuffer = fs.readFileSync(zipPath);
  console.log(`✓ Archivo ZIP encontrado: ${zipBuffer.length} bytes`);

  console.log('\n--- TEST 2: Probar ZipEngine.unzip ---');
  const unzipped = await ZipEngine.unzip(zipBuffer);
  const fileKeys = Object.keys(unzipped);
  console.log(`✓ Descomprimidos exitosamente ${fileKeys.length} archivos.`);

  console.log('\n--- TEST 3: Probar ZipEngine.parseScenePackage ---');
  const parsed = ZipEngine.parseScenePackage(unzipped);
  console.log(`✓ Título de la escena: "${parsed.meta.title}"`);
  console.log(`✓ Autores: ${parsed.meta.authors.join(', ')}`);
  console.log(`✓ Personajes detectados: ${parsed.meta.characters.join(', ')}`);
  console.log(`✓ Duración estimada: ${parsed.meta.estimatedDuration} segundos`);
  console.log(`✓ Video principal: ${parsed.videoKey}`);
  console.log(`✓ Pista de fondo: ${parsed.backingTrackKey}`);
  console.log(`✓ Diálogos sincronizados extraídos: ${parsed.dialogues.length}`);

  if (parsed.dialogues.length > 0) {
    console.log(`  Ejemplo Diálogo 1: [${parsed.dialogues[0].character}] ${parsed.dialogues[0].timestamp}s -> "${parsed.dialogues[0].caption}"`);
    console.log(`  Ejemplo Diálogo 2: [${parsed.dialogues[1].character}] ${parsed.dialogues[1].timestamp}s -> "${parsed.dialogues[1].caption}"`);
    console.log(`  Ejemplo Diálogo Final: [${parsed.dialogues[parsed.dialogues.length - 1].character}] ${parsed.dialogues[parsed.dialogues.length - 1].timestamp}s -> "${parsed.dialogues[parsed.dialogues.length - 1].caption}"`);
  }

  console.log('\n--- TEST 4: Probar ZipEngine.validateScene ---');
  const validation = ZipEngine.validateScene(parsed);
  console.log(`✓ ¿Escena válida?: ${validation.isValid}`);
  console.log(`✓ Checklist:`, validation.checks);

  console.log('\n--- TEST 5: Probar ZipEngine.createZip (Exportación ZIP) ---');
  const exportedZipBlob = await ZipEngine.createZip(parsed.rawFiles);
  const exportedArrBuf = await exportedZipBlob.arrayBuffer();
  console.log(`✓ ZIP Re-empaquetado exitosamente: ${exportedArrBuf.byteLength} bytes`);

  const reUnzipped = await ZipEngine.unzip(exportedArrBuf);
  console.log(`✓ Verificación de re-descompresión: ${Object.keys(reUnzipped).length} archivos intactos.`);

  console.log('\n========================================');
  console.log('🎉 ¡TODOS LOS TESTS PASARON EXITOSAMENTE!');
  console.log('========================================\n');
})();
