import OpenAI from "openai";
import fs from "fs";
import path from "path";

// ===== Chargement de sources.json sans "assert" =====
const sourcesPath = path.join(process.cwd(), "sources.json");

let sourcesConfig = { sources: [] };
try {
  const raw = fs.readFileSync(sourcesPath, "utf8");
  sourcesConfig = JSON.parse(raw);
} catch (e) {
  console.error("Impossible de charger sources.json :", e);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Recherche dans les sources prioritaires
async function searchSources(query, domains) {
  const results = [];

  for (const domain of domains) {
    const url = `https://api.duckduckgo.com/?q=site:${domain}+${encodeURIComponent(
      query
    )}&format=json`;

    try {
      const resp = await fetch(url); // fetch global (Node 18 / Vercel)
      const data = await resp.json();

      if (data?.RelatedTopics?.length > 0) {
        results.push({
          domain,
          snippet: data.RelatedTopics[0].Text || "Pas de données précises",
        });
      }
    } catch (err) {
      console.error(`Erreur recherche sur ${domain}:`, err.message);
    }
  }

  return results;
}

export default async function handler(req, res) {
  // ==================
  // 🔓 CORS
  // ==================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ==================
  // ⚙️ Paramètres
  // ==================
  const { school, program } = req.query;

  if (!school || !program) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const query = `${school} ${program} coût salaire employabilité`;
  const domains = (sourcesConfig.sources || []).flatMap((src) => src.domains || []);

  // ==================
  // 🔍 Recherche sources officielles
  // ==================
  const results = await searchSources(query, domains);

  if (results.length > 0) {
    const prompt = `
Voici des extraits trouvés sur des sources fiables pour l'école et le programme suivants :

École : "${school}"
Programme : "${program}"

Extraits :
${JSON.stringify(results, null, 2)}

À partir de ces éléments, renvoie un JSON STRICT (pas de texte autour) avec les clés :

{
  "cost": nombre ou null,                // coût total estimé de la formation en euros
  "averageSalary": nombre ou null,       // salaire brut annuel moyen à la sortie en euros
  "employabilityRate": nombre ou null,   // taux d'employabilité en %
  "source": "texte sur la source (url ou nom)",
  "schoolQueried": "${school}",
  "programQueried": "${program}"
}
`;

    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });

      const raw = completion.choices[0].message.content;
      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        console.error("Échec du parse JSON (sources trouvées)", raw);
        data = {
          cost: null,
          averageSalary: null,
          employabilityRate: null,
          source: "Réponse IA non parsée",
          schoolQueried: school,
          programQueried: program,
        };
      }

      return res.json({
        ...data,
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Erreur IA" });
    }
  }

  // ==================
  // 🤖 Fallback IA (aucune source trouvée)
  // ==================
  try {
    const prompt = `
Aucune source fiable n'a été trouvée automatiquement.

Donne une ESTIMATION prudente des statistiques suivantes pour :

École : "${school}"
Programme : "${program}"

Retourne STRICTEMENT un JSON (sans texte autour) avec les clés :

{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "texte expliquant qu'il s'agit d'une estimation IA ou d'une source générale",
  "schoolQueried": "${school}",
  "programQueried": "${program}"
}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0].message.content;
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Échec du parse JSON (fallback IA)", raw);
      data = {
        cost: null,
        averageSalary: null,
        employabilityRate: null,
        source: "Réponse IA non parsée",
        schoolQueried: school,
        programQueried: program,
      };
    }

    return res.json({
      ...data,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erreur IA fallback" });
  }
}
