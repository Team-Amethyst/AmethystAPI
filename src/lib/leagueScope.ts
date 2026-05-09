import { LeagueScope } from "../types/brain";

/**
 * AL / NL abbreviation sets include both MLB Stats API `/teams` forms (2025:
 * AZ, KC, TB, SF, SD, WSH) and common fantasy / legacy aliases (ARI, KCR,
 * TBR, SFG, SDP, WSN, CHW, OAK).
 */
const AL_ABBREVS = new Set([
  "BAL",
  "BOS",
  "NYY",
  "TB",
  "TBR",
  "TOR",
  "CWS",
  "CHW",
  "CLE",
  "DET",
  "KC",
  "KCR",
  "MIN",
  "HOU",
  "LAA",
  "OAK",
  "ATH",
  "SEA",
  "TEX",
]);

const NL_ABBREVS = new Set([
  "ATL",
  "MIA",
  "NYM",
  "PHI",
  "WSH",
  "WSN",
  "WAS",
  "CHC",
  "CIN",
  "MIL",
  "PIT",
  "STL",
  "ARI",
  "AZ",
  "COL",
  "LAD",
  "SD",
  "SDP",
  "SF",
  "SFG",
]);

const AL_NAMES = new Set([
  "BALTIMORE ORIOLES", "BOSTON RED SOX", "NEW YORK YANKEES",
  "TAMPA BAY RAYS", "TORONTO BLUE JAYS",
  "CHICAGO WHITE SOX", "CLEVELAND GUARDIANS", "DETROIT TIGERS",
  "KANSAS CITY ROYALS", "MINNESOTA TWINS",
  "HOUSTON ASTROS", "LOS ANGELES ANGELS", "OAKLAND ATHLETICS",
  "LAS VEGAS ATHLETICS", "ATHLETICS", "SEATTLE MARINERS", "TEXAS RANGERS",
]);

const NL_NAMES = new Set([
  "ATLANTA BRAVES", "MIAMI MARLINS", "NEW YORK METS",
  "PHILADELPHIA PHILLIES", "WASHINGTON NATIONALS",
  "CHICAGO CUBS", "CINCINNATI REDS", "MILWAUKEE BREWERS",
  "PITTSBURGH PIRATES", "ST. LOUIS CARDINALS",
  "ARIZONA DIAMONDBACKS", "COLORADO ROCKIES", "LOS ANGELES DODGERS",
  "SAN DIEGO PADRES", "SAN FRANCISCO GIANTS",
  "ARIZONA D-BACKS",
  "ARIZONA D BACKS",
  "D-BACKS",
  "D BACKS",
]);

/**
 * Returns true if the given MLB team belongs to the requested league scope.
 * Handles both 3-letter abbreviations and full team names.
 */
export function isPlayerInScope(mlbTeam: string, scope: LeagueScope): boolean {
  if (scope === "Mixed") return true;
  const upper = mlbTeam.toUpperCase().trim();
  if (scope === "AL") return AL_ABBREVS.has(upper) || AL_NAMES.has(upper);
  if (scope === "NL") return NL_ABBREVS.has(upper) || NL_NAMES.has(upper);
  return true;
}

/**
 * Filters an array of player-like objects by league scope.
 */
export function filterByScope<T extends { team: string }>(
  players: T[],
  scope: LeagueScope | undefined
): T[] {
  if (!scope || scope === "Mixed") return players;
  return players.filter((p) => isPlayerInScope(p.team, scope));
}
