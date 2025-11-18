import OpenAI from "openai";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// 🔹 sources.json est à la racine du repo
const sourcesPath = path.join(process.cwd(), "sources.json");
const sourcesConfig = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function searchSources(query, domains) {
  const results = [];

  for (const domain of domains) {
    const url = `https://api.duckduckgo.com/?q=site:${domain}+${encodeURIComponent(
      query
    )}&format=json`;
    try {
      const resp = await fetch(url);
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
  const { school, program } = req.query;

  if (!school || !program) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const query = `${school} ${program} coût salaire employabilité`;
  const domains = sourcesConfig.sources.flatMap((src) => src.domains);

  const results = await searchSources(query, domains);

  if (results.length > 0) {
    const prompt = `
    Voici des extraits trouvés sur des sources fiables :
    ${JSON.stringify(results, null, 2)}

    Normalise ces données et renvoie un JSON avec :
    - cost
    - averageSalary
    - employabilityRate
    - source
    `;
    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
      });
      const raw = completion.choices[0].message.content;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = {
          cost: null,
          averageSalary: null,
          employabilityRate: null,
          source: "Réponse IA non parsée",
        };
      }
      return res.json({ ...data, refreshedAt: new Date().toISOString() });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Erreur IA" });
    }
  }

  try {
    const prompt = `
    Donne-moi les statistiques suivantes pour l'école "${school}" et le programme "${program}" :
    - Coût de la formation (en euros)
    - Salaire moyen à la sortie (en euros)
    - Taux d'employabilité à la sortie (en %)
    Réponds uniquement en JSON avec les clés : cost, averageSalary, employabilityRate, source.
    `;
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const raw = completion.choices[0].message.content;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = {
        cost: null,
        averageSalary: null,
        employabilityRate: null,
        source: "Réponse IA non parsée",
      };
    }
    return res.json({ ...data, refreshedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erreur IA fallback" });
  }
}
