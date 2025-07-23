/* main.js – Vite-friendly solar dashboard */
import { GoogleGenAI } from "@google/genai";
import Chart           from "chart.js/auto";

/* ---------------- CONFIG ---------------- */
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API ?? "YOUR_GEMINI_KEY_HERE";
const SYS_CAP_KWP    = 5;
const TILT_DEG       = 20;

/* --------------- DOM refs --------------- */
const weatherBox = document.querySelector("#weatherNow .card-body");
const summaryBox = document.getElementById("summary");
const dailyCtx   = document.getElementById("dailyChart");
const hourlyCtx  = document.getElementById("hourlyChart");
let   dailyChart, hourlyChart;

/* ----------------- BOOT ----------------- */
/* ----------------- BOOT ----------------- */
(async () => {
    const city = new URLSearchParams(location.search).get("city") ?? "Kigali";
    summaryBox.textContent = `Loading solar forecast for ${city}…`;
  
    try {
      const { lat, lon } = await geocode(city);
      const forecast     = await fetchForecast(lat, lon);
      renderWeather(city, forecast.current);          // ← moved up
  
      const climatology  = await fetchClimatology(lat, lon);
  
      let gem;
      try {
        gem = await askGemini(city, forecast, climatology);
        drawDashboard(gem);
      } catch (aiErr) {
        console.warn("Gemini failed, showing weather only:", aiErr);
        summaryBox.textContent = "Live PV forecast unavailable (AI error).";
      }
    } catch (e) {
      console.error(e);
      summaryBox.textContent = `Error: ${e.message}`;
    }
  })();
  

/* -------------- helpers ----------------- */
async function geocode(city) {
  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&format=json&limit=1`;
  const [hit] = await fetch(url, { headers: { Accept: "application/json" } }).then(r => r.json());
  if (!hit) throw new Error("City not found");
  return { lat: +hit.lat, lon: +hit.lon };
}

async function fetchForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
              `&hourly=temperature_2m,cloudcover,direct_radiation` +
              `&current_weather=true&timezone=Africa%2FKigali`;
  const d = await fetch(url).then(r => r.json());
  return {
    time:             d.hourly.time.slice(0, 168),
    temperature_2m:   d.hourly.temperature_2m.slice(0, 168),
    cloudcover:       d.hourly.cloudcover.slice(0, 168),
    direct_radiation: d.hourly.direct_radiation.slice(0, 168),
    current:          d.current_weather ?? d.current ?? null
  };
}

async function fetchClimatology(lat, lon) {
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?latitude=${lat}` +
              `&longitude=${lon}&community=RE&parameters=` +
              `ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M&format=JSON`;
  const json = await fetch(url).then(r => r.json());
  return json.properties?.parameter;
}

/* ------ GEMINI – robust JSON  ----------- */
async function askGemini(city, forecast, climatology) {
  const prompt = [
    "You are a photovoltaic-performance analyst.",
    "Return ONE JSON object only (no ``` fences).",
    "Keys: daily[{date,kwh}], hourly[{timestamp,kwh}], summary (≤60 words).",
    `OBJECTIVE: ${SYS_CAP_KWP} kWp roof in ${city}, tilt ${TILT_DEG}°.`,
    `INPUT_A: ${JSON.stringify(forecast)}`,
    `INPUT_B: ${JSON.stringify(climatology)}`
  ].join("\n");

  const ai     = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    generationConfig: { response_mime_type: "application/json" }
  });

  const raw = result.text ?? result?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const braceMatch = raw.match(/[{\[][\s\S]*[}\]]/);
  if (!braceMatch) throw new Error("Gemini sent no object/array");

  let data;
  try { data = JSON.parse(braceMatch[0]); }
  catch { data = JSON.parse(JSON.parse(braceMatch[0])); }

  if (!Array.isArray(data?.daily) || !Array.isArray(data?.hourly))
    throw new Error("Gemini JSON missing daily/hourly arrays");

  return data;
}

/* ---------- UI renderers --------------- */
function renderWeather(city, cw) {
    if (!cw) {
            weatherBox.innerHTML =
              `<span class="text-muted"><i class="fa-solid fa-triangle-exclamation fa-fw"></i>
               Live weather unavailable for ${city}</span>`;
            return;
          }
        
          const tpl = `
<span class="badge bg-primary-subtle text-primary-emphasis fs-6"><i class="fa-solid fa-city fa-fw"></i> ${city}</span>
    <span class="badge bg-warning-subtle text-warning-emphasis fs-6"><i class="fa-solid fa-temperature-high fa-fw"></i> ${cw.temperature} °C</span>
    <span class="badge bg-info-subtle text-info-emphasis fs-6"><i class="fa-solid fa-cloud fa-fw"></i> ${cw.weathercode ? weatherLabel(cw.weathercode) : "—"}</span>
    <span class="badge bg-success-subtle text-success-emphasis fs-6"><i class="fa-solid fa-wind fa-fw"></i> ${cw.windspeed} km/h</span>
  `;
  weatherBox.innerHTML = tpl;
}

function weatherLabel(code) {
  // very simple mapping 
  return (code < 3) ? "Clear" :
         (code < 45) ? "Partly cloudy" :
         (code < 55) ? "Fog / Drizzle" :
         (code < 65) ? "Rain" :
         (code < 75) ? "Snow" :
         "Stormy";
}

function drawDashboard(d) {
  summaryBox.textContent = d.summary;

  /* daily bar */
  dailyChart?.destroy();
  dailyChart = new Chart(dailyCtx, {
    type: "bar",
    data: {
      labels: d.daily.map(x => x.date.slice(5)),
      datasets: [{ data: d.daily.map(x => x.kwh), backgroundColor: "rgba(75,192,192,.6)" }]
    },
    options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
  });

  /* hourly line */
  hourlyChart?.destroy();
  hourlyChart = new Chart(hourlyCtx, {
    type: "line",
    data: {
      labels: d.hourly.map(x => x.timestamp.slice(11, 16)),
      datasets: [{
        data: d.hourly.map(x => x.kwh),
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderColor: "#9966ff",
        backgroundColor: "rgba(153,102,255,.2)"
      }]
    },
    options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
  });
}
