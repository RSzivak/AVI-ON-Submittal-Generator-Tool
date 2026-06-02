import * as pdfjsLib from 'pdfjs-dist';
import { SPEC_REGISTRY } from './specRegistry';

// Standard CDN worker link for Vite/Electron stability
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

/**
 * Parses an uploaded BOM PDF and returns an array of matching spec sheet filenames.
 * @param {File} file - The raw PDF File object
 * @returns {Promise<string[]>} - Array of spec sheet filenames
 */
export const parseBomForSpecSheets = async (file) => {
  console.log("=== BOM PARSING INITIATED ===");
  console.log(`Processing file: ${file.name} (${file.size} bytes)`);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    console.log(`BOM PDF loaded successfully. Total pages: ${pdf.numPages}`);

    let extractedText = '';

    // Loop through every page to extract text strings
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      extractedText += ` ${pageText}`;
    }

    // DEBUG: Print the raw text to the console so you can see what the app sees
    console.log("=== RAW EXTRACTED TEXT FROM PDF ===");
    console.log(extractedText);
    console.log("===================================");

    const matchedSheets = new Set();

    // Check for exact part number inclusion
    Object.keys(SPEC_REGISTRY).forEach(partNumber => {
      // Skip the empty keys you have at the bottom of your registry
      if (!partNumber) return; 

      if (extractedText.includes(partNumber)) {
        console.log(`✅ MATCH FOUND: '${partNumber}' -> Requires '${SPEC_REGISTRY[partNumber]}'`);
        matchedSheets.add(SPEC_REGISTRY[partNumber]);
      }
    });

    const finalMatches = Array.from(matchedSheets);
    console.log("=== FINAL ARRAY OF MATCHED SHEETS ===", finalMatches);
    
    return finalMatches;

  } catch (error) {
    console.error("❌ Error reading text content from BOM PDF:", error);
    throw new Error("Could not parse BOM file text layers.");
  }
};