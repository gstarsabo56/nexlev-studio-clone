// Multi-Locale Parsers for Views/Subscribers, Relative Dates, and Video Formats (Batch 1)
// Returns explicit { value, status, reason } and never invents fallback numbers.

/**
 * Supported locales for count & relative date parsing:
 * en, de, fr, es, pt, it, nl, ja, ko, zh, vi
 */
export const SUPPORTED_PARSER_LOCALES = new Set([
  "en", "de", "fr", "es", "pt", "it", "nl", "ja", "ko", "zh", "vi"
]);

/**
 * Parses localized YouTube view/subscriber count strings into exact or rounded integers.
 * Fixes 1B = 1,000,000,000 (1e9) vs Korean 억 / Japanese/Chinese 億 (1e8).
 * Handles comma/dot decimal vs thousands separators across locales.
 */
export function parseCountTextStrict(rawInput, localeHint = "en") {
  if (typeof rawInput === "number" && Number.isFinite(rawInput) && rawInput >= 0) {
    return {
      value: Math.round(rawInput),
      status: "observed",
      raw: String(rawInput),
      isRounded: false,
      reason: null
    };
  }

  if (rawInput === null || rawInput === undefined) {
    return {
      value: null,
      status: "unknown",
      raw: "",
      isRounded: false,
      reason: "empty_count_input"
    };
  }

  const raw = String(rawInput).trim();
  if (!raw) {
    return {
      value: null,
      status: "unknown",
      raw,
      isRounded: false,
      reason: "empty_count_input"
    };
  }

  const lang = String(localeHint || "en").slice(0, 2).toLowerCase();
  if (localeHint && !SUPPORTED_PARSER_LOCALES.has(lang)) {
    return {
      value: null,
      status: "unknown",
      raw,
      isRounded: false,
      reason: `unsupported_locale:${localeHint}`
    };
  }

  const lower = raw.toLowerCase();
  if (
    /no views|keine aufrufe|aucune vue|sin vistas|sem visualizações|nessuna visualizzazione|geen weergaven|視聴回数 0|조회수 없음|無觀看次數|không có lượt xem/.test(
      lower
    )
  ) {
    return {
      value: 0,
      status: "observed",
      raw,
      isRounded: false,
      reason: null
    };
  }

  // Strip known label words (views, subscribers, Aufrufe, vues, lượt xem, etc.)
  const stripped = raw
    .replace(
      /\b(views?|subscribers?|subs?|aufrufe|abonnenten|vues|abonnés|visualizaciones|vistas|suscriptores|visualizações|inscritos|visualizzazioni|iscritti|weergaven|abonnees)\b/gi,
      " "
    )
    .replace(/(lượt xem|người đăng ký|回視聴|視聴回数|人のチャンネル登録者|チャンネル登録者数|조회수|구독자|회|명|次觀看|觀看次數|位訂閱者)/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim();

  // Match number part + optional unit suffix
  const match = stripped.match(
    /^([0-9]+(?:[.,\s][0-9]+)*)\s*(mrd\.?|mio\.?|md\.?|mil\s+millones|millones|milioni|milliard[es]?|million[es]?|mil|mi\b|bi\b|tỷ|tr\b|triệu|nghìn|ngàn|k\b|m\b|b\b|n\b|천|만|억|千|万|萬|億|lakh|crore)?$/i
  );

  if (!match) {
    return {
      value: null,
      status: "unknown",
      raw,
      isRounded: false,
      reason: "unrecognized_count_pattern"
    };
  }

  const numToken = match[1].replace(/\s+/g, "");
  const unitToken = (match[2] || "").trim().toLowerCase().replace(/\.$/, "");

  // Determine multiplier from unit
  let multiplier = 1;
  if (unitToken) {
    if (["k", "n", "nghìn", "ngàn", "mil", "천", "千"].includes(unitToken)) {
      multiplier = 1_000;
    } else if (["만", "万", "萬"].includes(unitToken)) {
      multiplier = 10_000;
    } else if (unitToken === "lakh") {
      multiplier = 100_000;
    } else if (
      ["m", "mio", "tr", "triệu", "mi", "million", "millions", "millones", "milioni"].includes(
        unitToken
      )
    ) {
      multiplier = 1_000_000;
    } else if (unitToken === "crore") {
      multiplier = 10_000_000;
    } else if (["억", "億"].includes(unitToken)) {
      multiplier = 100_000_000;
    } else if (
      ["b", "bi", "mrd", "md", "tỷ", "milliard", "milliards", "milliarden"].includes(unitToken) ||
      /mil\s+millones/.test(unitToken)
    ) {
      multiplier = 1_000_000_000;
    } else {
      return {
        value: null,
        status: "unknown",
        raw,
        isRounded: false,
        reason: `unsupported_unit:${unitToken}`
      };
    }
  }

  // Parse numeric part respecting decimal vs thousand separators
  let numericValue;
  const commaDecimalLocales = new Set(["de", "fr", "es", "pt", "it", "nl", "vi"]);

  if (multiplier > 1) {
    // When a unit suffix is present (e.g. "1.5M" or "1,5 Mio"), a single dot or comma is a decimal point
    const normalized = numToken.replace(",", ".");
    if ((normalized.match(/\./g) || []).length > 1) {
      return {
        value: null,
        status: "unknown",
        raw,
        isRounded: false,
        reason: "ambiguous_decimal_with_unit"
      };
    }
    numericValue = parseFloat(normalized);
  } else {
    // No unit suffix: separators are thousands separators if grouped in 3s
    if (/^\d{1,3}(,\d{3})+$/.test(numToken)) {
      numericValue = parseInt(numToken.replace(/,/g, ""), 10);
    } else if (/^\d{1,3}(\.\d{3})+$/.test(numToken)) {
      numericValue = parseInt(numToken.replace(/\./g, ""), 10);
    } else if (/^\d+$/.test(numToken)) {
      numericValue = parseInt(numToken, 10);
    } else if (commaDecimalLocales.has(lang) && /^\d+,\d+$/.test(numToken)) {
      numericValue = parseFloat(numToken.replace(",", "."));
    } else if (!commaDecimalLocales.has(lang) && /^\d+\.\d+$/.test(numToken)) {
      numericValue = parseFloat(numToken);
    } else {
      return {
        value: null,
        status: "unknown",
        raw,
        isRounded: false,
        reason: "ambiguous_number_separators"
      };
    }
  }

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return {
      value: null,
      status: "unknown",
      raw,
      isRounded: false,
      reason: "invalid_numeric_value"
    };
  }

  return {
    value: Math.round(numericValue * multiplier),
    status: "observed",
    raw,
    isRounded: multiplier > 1,
    reason: null
  };
}

/**
 * Parses relative published time strings across all 11 supported languages:
 * en, de, fr, es, pt, it, nl, ja, ko, zh, vi.
 * Never returns a magic default (like 12 days) on failure!
 */
export function parsePublishedTextStrict(rawInput, collectedAtIso = null) {
  if (typeof rawInput === "number" && Number.isFinite(rawInput) && rawInput >= 0) {
    const days = Math.max(0.04, rawInput);
    const refMs = collectedAtIso ? Date.parse(collectedAtIso) : Date.now();
    return {
      publishedDaysAgo: Number(days.toFixed(2)),
      estimatedPublishedAt: Number.isFinite(refMs)
        ? new Date(refMs - days * 86400_000).toISOString()
        : null,
      status: "observed",
      raw: String(rawInput),
      reason: null
    };
  }

  const raw = String(rawInput || "").trim();
  if (!raw) {
    return {
      publishedDaysAgo: null,
      estimatedPublishedAt: null,
      status: "unknown",
      raw,
      reason: "empty_published_text"
    };
  }

  // Direct ISO date check
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsedMs = Date.parse(raw);
    if (Number.isFinite(parsedMs)) {
      const refMs = collectedAtIso ? Date.parse(collectedAtIso) : Date.now();
      const days = Math.max(0.04, (refMs - parsedMs) / 86400_000);
      return {
        publishedDaysAgo: Number(days.toFixed(2)),
        estimatedPublishedAt: new Date(parsedMs).toISOString(),
        status: "observed",
        raw,
        reason: null
      };
    }
  }

  const s = raw.toLowerCase();

  // Pattern for number + unit across 11 languages:
  // en: minute/hour/day/week/month/year
  // de: minute/stunde/tag/woche/monat/jahr
  // fr: minute/heure/jour/semaine/mois/an/année
  // es: minuto/hora/día/dia/semana/mes/meses/año/ano
  // pt: minuto/hora/dia/semana/mês/meses/ano
  // it: minuto/ora/ore/giorno/giorni/settimana/settimane/mese/mesi/anno/anni
  // nl: minuut/minuten/uur/dag/dagen/week/weken/maand/maanden/jaar
  // vi: phút/giờ/ngày/tuần/tháng/năm
  // ko: 분/시간/일/주/개월/달/년
  // ja: 分/時間/日/週間/週/か月/ヶ月/月/年
  // zh: 分鐘/小時/天/日/週/星期/個月/年
  const regex =
    /(\d+)\s*(minutes?|mins?|stunde[n]?|heures?|horas?|ore|ora|uur|uren|giờ|시간|時間|小時|phút|분|分|分鐘|days?|tage[n]?|tag|jours?|días?|dias?|giorni|giorno|dagen|dag|ngày|일|日|天|weeks?|wochen?|semaines?|semanas?|settimane|settimana|weken|tuần|주|週間|週|星期|months?|monate[n]?|monat|mois|meses|mês|mes|mesi|mese|maanden|maand|tháng|개월|달|か月|ヶ月|個月|years?|jahre[n]?|jahr|ans?|années?|años?|anos?|anni|anno|jaar|jaren|năm|년|年)/i;

  const m = s.match(regex);
  if (!m) {
    return {
      publishedDaysAgo: null,
      estimatedPublishedAt: null,
      status: "unknown",
      raw,
      reason: "unrecognized_published_time_format"
    };
  }

  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();

  let days;
  if (/^(minute|min|phút|분|分|分鐘)/.test(u)) {
    days = Math.max(0.02, n / 1440);
  } else if (/^(hour|stunde|heure|hora|ore|ora|uur|uren|giờ|시간|時間|小時)/.test(u)) {
    days = Math.max(0.04, n / 24);
  } else if (/^(day|tag|jour|día|dia|giorn|dag|ngày|일|日|天)/.test(u)) {
    days = Math.max(1, n);
  } else if (/^(week|woch|semaine|semana|settiman|wek|tuần|주|週間|週|星期)/.test(u)) {
    days = n * 7;
  } else if (/^(month|monat|mois|mes|mês|maand|tháng|개월|달|か月|ヶ月|個月)/.test(u)) {
    days = n * 30;
  } else if (/^(year|jahr|an|año|ano|ann|jaar|jaren|năm|년|年)/.test(u)) {
    days = n * 365;
  } else {
    return {
      publishedDaysAgo: null,
      estimatedPublishedAt: null,
      status: "unknown",
      raw,
      reason: `unmapped_time_unit:${u}`
    };
  }

  const refMs = collectedAtIso ? Date.parse(collectedAtIso) : Date.now();
  return {
    publishedDaysAgo: Number(days.toFixed(2)),
    estimatedPublishedAt: Number.isFinite(refMs)
      ? new Date(refMs - days * 86400_000).toISOString()
      : null,
    publishedAt: Number.isFinite(refMs)
      ? new Date(refMs - days * 86400_000).toISOString()
      : null,
    ageDays: Number(days.toFixed(2)),
    value: Number.isFinite(refMs)
      ? new Date(refMs - days * 86400_000).toISOString()
      : null,
    status: "derived",
    raw,
    reason: null
  };
}

/**
 * Parses video duration from seconds, "HH:MM:SS" / "MM:SS", or ISO-8601 "PT1H12M30S".
 * Never returns a fake default duration (like 1080s / 18m) when duration is missing!
 */
export function parseDurationSecondsStrict(rawInput) {
  if (typeof rawInput === "number" && Number.isFinite(rawInput) && rawInput > 0) {
    const sec = Math.round(rawInput);
    return {
      seconds: sec,
      minutes: Number((sec / 60).toFixed(2)),
      status: "observed",
      raw: String(rawInput),
      reason: null
    };
  }

  const raw = String(rawInput || "").trim();
  if (!raw) {
    return {
      seconds: null,
      minutes: null,
      status: "unknown",
      raw,
      reason: "empty_duration"
    };
  }

  // ISO-8601 duration e.g. PT1H12M30S or PT45S
  const isoMatch = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (isoMatch && (isoMatch[1] || isoMatch[2] || isoMatch[3])) {
    const h = parseInt(isoMatch[1] || "0", 10);
    const m = parseInt(isoMatch[2] || "0", 10);
    const s = parseInt(isoMatch[3] || "0", 10);
    const sec = h * 3600 + m * 60 + s;
    return {
      seconds: sec,
      minutes: Number((sec / 60).toFixed(2)),
      status: "observed",
      raw,
      reason: null
    };
  }

  // Colon format HH:MM:SS or MM:SS
  if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(":").map((n) => parseInt(n, 10));
    let sec = 0;
    if (parts.length === 3) {
      sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      sec = parts[0] * 60 + parts[1];
    }
    if (sec > 0) {
      return {
        seconds: sec,
        minutes: Number((sec / 60).toFixed(2)),
        status: "observed",
        raw,
        reason: null
      };
    }
  }

  return {
    seconds: null,
    minutes: null,
    status: "unknown",
    raw,
    reason: "unrecognized_duration_format"
  };
}

export function parseDurationTextToMinutes(rawInput) {
  return parseDurationSecondsStrict(rawInput).minutes;
}

export const parseViewOrSubscriberCount = parseCountTextStrict;

export function parseRelativePublishedDate(rawInput, refTime = null) {
  const refIso =
    typeof refTime === "number" && Number.isFinite(refTime)
      ? new Date(refTime).toISOString()
      : refTime;
  const res = parsePublishedTextStrict(rawInput, refIso);
  return {
    ...res,
    value: res.estimatedPublishedAt,
    ageDays: res.publishedDaysAgo
  };
}

/**
 * Classifies an individual video into 'shorts' | 'long' | 'live' | 'unknown'.
 * Never uses the channel's average video duration.
 */
export function classifyVideoContentType({
  isLive = false,
  isUpcoming = false,
  isShorts = false,
  url = "",
  title = "",
  durationSeconds = null,
  durationMinutes = null
} = {}) {
  if (isLive || isUpcoming) return "live";
  if (isShorts || /\/shorts\//i.test(String(url)) || /#shorts\b/i.test(String(title))) {
    return "shorts";
  }

  const sec =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
      ? durationSeconds
      : typeof durationMinutes === "number" && Number.isFinite(durationMinutes)
        ? Math.round(durationMinutes * 60)
        : null;

  if (sec !== null && sec > 0) {
    if (sec <= 60) return "shorts";
    return "long";
  }

  return "unknown";
}

