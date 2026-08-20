const fs = require('fs');
const https = require('https');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 1: Parse TTML2 XML â†’ Clean Transcript
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function parseXmlToTranscript(xmlContent) {
  const lines = [];

  // Extract all <p> elements with begin/end timestamps
  const pRegex = /<p\s+begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = pRegex.exec(xmlContent)) !== null) {
    const timestamp = match[1];
    let text = match[2];

    // Strip all XML/HTML tags but keep line breaks as spaces
    text = text.replace(/<br\s*\/?>/gi, ' ');
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'")
               .replace(/&apos;/g, "'");

    // Trim whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Skip empty lines, pure music cues, and sound-only lines
    if (!text) continue;
    if (/^â™ª+\s*â™ª*$/.test(text)) continue; // Skip pure music notes like "â™ª â™ª"

    // Remove leading/trailing music symbols from song lyrics (keep the text)
    text = text.replace(/^â™ª\s*/, '').replace(/\s*â™ª+$/, '').trim();

    // Skip if nothing left after stripping music
    if (!text) continue;

    // Skip "Previously on" recap lines (optional â€” can be toggled)
    // if (text.startsWith('Previously on')) continue;

    lines.push(`[${timestamp}] ${text}`);
  }

  return lines;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 2: Identify unique characters from speaker labels
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function extractCharacters(lines) {
  const characters = new Set();
  const speakerRegex = /\[([A-Za-z\s'.]+)\]/g;

  for (const line of lines) {
    // Match [Speaker] patterns â€” skip timestamps at the start
    const textPart = line.replace(/^\[[^\]]+\]\s*/, ''); // Remove timestamp
    let m;
    while ((m = speakerRegex.exec(textPart)) !== null) {
      const name = m[1].trim();
      // Filter out sound effects â€” must be a proper name (capitalized, no verbs)
      const sfxPatterns = /^(laughs|sighs|gasps|groans|scoffs|chuckles|coughs|sniffs|exhales|inhales|crying|screaming|grunts|whimpers|sobbing|panting|knocking|doorbell|phone|song|music|indistinct|wind|thunder|gunshot|explosion|applause|cheering|laughter|clears|exclaims|whispers|giggles|school|excited|whooping|others|loud|both|door|laughing|all|groaning|band|people|engine|sniffling|knock|stammers|line|rings|chatter|closes|starts|ringing|warming|bell|softly|weakly|quietly|sharply|continues|playing|faintly|vibrating|whooshing)/i;
      if (!sfxPatterns.test(name) && name.length > 1 && !name.includes(' ')) {
        characters.add(name);
      } else if (!sfxPatterns.test(name) && name.length > 1) {
        // Allow multi-word names only if they look like actual names (e.g., "Billy Butcher")
        const words = name.split(' ');
        const looksLikeName = words.every(w => /^[A-Z]/.test(w));
        if (looksLikeName && words.length <= 3) {
          characters.add(name);
        }
      }
    }

    // Also match "NAME:" patterns (e.g., "FRENCHIE: Already disabled.")
    const colonMatch = textPart.match(/^([A-Z][A-Z\s'.]+):\s/);
    if (colonMatch) {
      characters.add(colonMatch[1].trim());
    }
  }

  return [...characters];
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 3: Call Gemini API for forensic death analysis
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function callGemini(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json"
      }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) {
            return reject(new Error(`Gemini API Error: ${json.error.message}`));
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error(`Unexpected Gemini response: ${body.substring(0, 500)}`));
          }
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Gemini response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MAIN
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node analyze_deaths.js <subtitle_file.xml>');
    process.exit(1);
  }

  const xmlFile = args[0];
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  // Read and parse the XML
  console.log(`[1] Reading ${xmlFile}...`);
  const xml = fs.readFileSync(xmlFile, 'utf8');
  const lines = parseXmlToTranscript(xml);
  console.log(`    Extracted ${lines.length} dialogue lines.`);

  // Extract characters
  const characters = extractCharacters(lines);
  console.log(`    Identified ${characters.length} characters: ${characters.join(', ')}`);

  // Build the transcript
  const transcript = lines.join('\n');

  // Build the forensic prompt
  const prompt = `You are an expert forensic analyst specializing in TV/film narrative analysis. Your task is to analyze the following episode transcript (extracted from subtitles) and identify EVERY character death that occurs or is referenced in this episode.

CRITICAL INSTRUCTIONS:
1. Identify ALL deaths â€” both on-screen and off-screen, past and present.
2. For EACH death, classify it as:
   - "on_screen" = the character dies during the events of THIS episode
   - "referenced" = the death happened before this episode but is mentioned/discussed
   - "implied" = strong contextual evidence suggests a death but it's not explicitly confirmed
3. Look for these DEATH INDICATORS:
   - EXPLICIT: "he's dead", "she died", "killed him", "murdered", "passed away", "RIP", "funeral"
   - CONTEXTUAL: gunshots + screaming + silence, body found, "we lost her", "gone forever"
   - EUPHEMISTIC: "took care of it", "handled the problem", "won't be coming back", "put down"
   - MEDICAL: "cancer", "terminal", "not doing treatment", "the trial didn't work"
   - IMPLIED: character goes silent after violence, others mourn without naming the event
4. For referenced deaths, note what is said about when/how they died.
5. Be thorough but avoid false positives â€” figurative speech like "you're killing me" or "I could die of embarrassment" is NOT a real death.
6. Include confidence level: "high" (explicitly stated), "medium" (strongly implied), "low" (possible but ambiguous).

CHARACTERS DETECTED IN THIS EPISODE: ${characters.join(', ')}

FULL EPISODE TRANSCRIPT:
${transcript}

Respond with a JSON object in this exact format:
{
  "episode_summary": "A brief 2-3 sentence summary of the episode's plot",
  "deaths": [
    {
      "character": "Character Name",
      "type": "on_screen | referenced | implied",
      "confidence": "high | medium | low",
      "timestamp": "HH:MM:SS or 'N/A' if referenced from past",
      "cause_of_death": "How they died",
      "evidence": "The specific dialogue/context that indicates this death"
    }
  ],
  "total_deaths_on_screen": 0,
  "total_deaths_referenced": 0,
  "characters_at_risk": [
    {
      "character": "Character Name",
      "reason": "Why they might be in danger based on dialogue"
    }
  ]
}

If NO deaths occur or are referenced, return an empty deaths array. Be thorough and precise.`;

  console.log(`[2] Sending ${transcript.length} characters to Gemini 2.5 Flash for analysis...`);
  
  try {
    const result = await callGemini(GEMINI_API_KEY, prompt);
    
    // Parse the JSON result
    let analysis;
    try {
      analysis = JSON.parse(result);
    } catch (e) {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/) || result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } else {
        console.error('Failed to parse Gemini response as JSON:', result);
        process.exit(1);
      }
    }

    // Display results
    console.log(`\n${'â•'.repeat(60)}`);
    console.log(`  FORENSIC DEATH ANALYSIS REPORT`);
    console.log(`  File: ${xmlFile}`);
    console.log(`${'â•'.repeat(60)}\n`);
    
    console.log(`ðŸ“‹ Episode Summary:`);
    console.log(`   ${analysis.episode_summary}\n`);

    if (analysis.deaths && analysis.deaths.length > 0) {
      console.log(`ðŸ’€ DEATHS DETECTED (${analysis.deaths.length}):\n`);
      for (const death of analysis.deaths) {
        const icon = death.type === 'on_screen' ? 'ðŸ”´' : death.type === 'referenced' ? 'ðŸ“–' : 'â“';
        console.log(`   ${icon} ${death.character}`);
        console.log(`      Type: ${death.type} | Confidence: ${death.confidence}`);
        console.log(`      Timestamp: ${death.timestamp}`);
        console.log(`      Cause: ${death.cause_of_death}`);
        console.log(`      Evidence: "${death.evidence}"`);
        console.log('');
      }
    } else {
      console.log(`   âœ… No deaths detected in this episode.\n`);
    }

    if (analysis.characters_at_risk && analysis.characters_at_risk.length > 0) {
      console.log(`âš ï¸  CHARACTERS AT RISK:`);
      for (const c of analysis.characters_at_risk) {
        console.log(`   - ${c.character}: ${c.reason}`);
      }
      console.log('');
    }

    console.log(`ðŸ“Š Summary: ${analysis.total_deaths_on_screen || 0} on-screen, ${analysis.total_deaths_referenced || 0} referenced`);

    // Save full report to JSON
    const reportFile = xmlFile.replace('.xml', '_death_report.json');
    fs.writeFileSync(reportFile, JSON.stringify(analysis, null, 2));
    console.log(`\nðŸ’¾ Full report saved to: ${reportFile}`);
    
  } catch (err) {
    console.error(`\n[!] Gemini API Error: ${err.message}`);
    process.exit(1);
  }
}

main();
