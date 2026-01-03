// ============================================================================
// App.jsx
// Main application component for the Counterpoint music history map.
// ============================================================================
//
// DESCRIPTION:
//   Counterpoint visualizes music history as a transit-style map, showing
//   connections between artists through band membership, collaborations,
//   co-writing credits, and shared record labels.
//
// KEY FEATURES:
//   - Search and add artists from MusicBrainz database
//   - Visualize artists as nodes with connection lines between them
//   - Four connection types: Personnel (green), Studio (blue), Writing (purple), Label (yellow)
//   - Route-finding between any two artists
//   - Artist photos fetched from Wikidata
//   - Dark/light mode support
//
// SECTIONS:
//   1. CONSTANTS - Grid sizes, colors, labels
//   2. API FUNCTIONS - MusicBrainz & Wikidata fetching
//   3. GEOMETRY UTILITIES - Path generation, grid calculations
//   4. DATA PROCESSING - Extract relationships, works, labels
//   5. LAYOUT - Auto-positioning of artists on the map
//   6. MAIN COMPONENT - React component with state, handlers, and render
//
// ============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Music, Sun, Moon, Search, Loader, AlertCircle, Plus, X, Navigation } from 'lucide-react';


// ============================================================================
// 1. CONSTANTS
// Grid layout, hub positions, colors, and labels for the transit map
// ============================================================================

/** Grid cell size in pixels */
const GRID_SIZE = 150;

/** Radius of each station (artist node) in pixels */
const STATION_RADIUS = 28;

/** Gap between parallel connection lines */
const LINE_GAP = 12;

/**
 * Hub positions for layout weighting
 * Artists are positioned based on their connection types, gravitating toward relevant hubs
 */
const HUBS = {
  personnel: { x: -3, y: -2 },  // Northwest - "Band District"
  studio: { x: 4, y: 2 },       // Southeast - "Recording District"
  tour: { x: 2, y: -4 },        // Northeast - "Performance District"
};

// Calculate artist position based on connection type weights
function calculateHubPosition(artistData) {
  if (!artistData.relations || artistData.relations.length === 0) {
    return { x: 0, y: 0 }; // Default center if no connections
  }

  // Count connection types
  const weights = { member: 0, studio: 0, writing: 0, label: 0 };
  artistData.relations.forEach(rel => {
    const type = rel.type === 'member of band' ? 'member' :
                 rel.type === 'collaboration' || rel.type === 'production' ? 'studio' :
                 rel.type === 'writer' || rel.type === 'composer' || rel.type === 'lyricist' || rel.type === 'songwriter' ? 'writing' :
                 rel.label ? 'label' : null;  // Any relationship with a label entity
    if (type) weights[type]++;
  });

  const total = weights.member + weights.studio + weights.writing + weights.label;
  if (total === 0) return { x: 0, y: 0 };

  // Extended hub positions for new types
  const hubs = {
    ...HUBS,
    writing: { x: -4, y: 3 },   // Southwest - "Songwriting District"
    label: { x: 5, y: -3 }      // East - "Business District"
  };

  // Weighted average of hub positions
  const x = (
    (weights.member / total) * hubs.personnel.x +
    (weights.studio / total) * hubs.studio.x +
    (weights.writing / total) * hubs.writing.x +
    (weights.label / total) * hubs.label.x
  );

  const y = (
    (weights.member / total) * hubs.personnel.y +
    (weights.studio / total) * hubs.studio.y +
    (weights.writing / total) * hubs.writing.y +
    (weights.label / total) * hubs.label.y
  );

  // Snap to grid (round to nearest integer)
  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

// ============================================================================
// 2. API FUNCTIONS
// MusicBrainz and Wikidata API calls with rate limiting
// ============================================================================

/** MusicBrainz API base URL */
const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const APP_NAME = 'Counterpoint';
const APP_VERSION = '1.0.0';
const CONTACT = 'your-email@example.com'; // Replace with your email

/**
 * Rate-limited fetch for MusicBrainz API (1 request/sec required)
 * @param {string} url - The URL to fetch
 * @returns {Promise<Object>} Parsed JSON response
 */
let lastRequestTime = 0;
async function rateLimitedFetch(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': `${APP_NAME}/${APP_VERSION} ( ${CONTACT} )`
    }
  });
  
  if (!response.ok) {
    throw new Error(`MusicBrainz API error: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Search for artists in MusicBrainz
 * @param {string} query - Search query
 * @returns {Promise<Array>} Array of artist objects
 */
async function searchMusicBrainzArtist(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `${MUSICBRAINZ_API}/artist?query=${encodedQuery}&fmt=json&limit=10`;
  const data = await rateLimitedFetch(url);
  return data.artists || [];
}

/**
 * Get full artist details from MusicBrainz by MBID
 * @param {string} mbid - MusicBrainz ID
 * @returns {Promise<Object>} Artist details with relationships
 */
async function getArtistDetails(mbid) {
  const url = `${MUSICBRAINZ_API}/artist/${mbid}?inc=artist-rels+recording-rels+work-rels+label-rels+url-rels+genres+tags&fmt=json`;
  return await rateLimitedFetch(url);
}

/**
 * Extract Wikidata ID from artist's URL relationships
 * @param {Object} artistData - Artist data from MusicBrainz
 * @returns {string|null} Wikidata ID (e.g., "Q2831") or null if not found
 */
function extractWikidataId(artistData) {
  if (!artistData.relations) return null;

  for (const rel of artistData.relations) {
    if (rel.type === 'wikidata' && rel.url?.resource) {
      // URL format: https://www.wikidata.org/wiki/Q2831
      const match = rel.url.resource.match(/wikidata\.org\/wiki\/(Q\d+)/);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Fetch artist image URL from Wikidata
 * @param {string} wikidataId - Wikidata entity ID (e.g., "Q2831")
 * @returns {Promise<string|null>} Image URL or null if not found
 */
async function fetchWikidataImage(wikidataId) {
  if (!wikidataId) return null;

  try {
    const url = `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const entity = data.entities[wikidataId];

    // P18 is the property for "image"
    const imageClaim = entity?.claims?.P18?.[0];
    if (!imageClaim) return null;

    const imageName = imageClaim.mainsnak?.datavalue?.value;
    if (!imageName) return null;

    // Convert filename to Wikimedia Commons URL
    const encodedName = encodeURIComponent(imageName.replace(/ /g, '_'));
    // Use Wikimedia's thumbnail API for a reasonable size
    const imageUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodedName}?width=300`;

    return imageUrl;
  } catch (err) {
    console.error('Failed to fetch Wikidata image:', err);
    return null;
  }
}

// ============================================================================
// 3. GEOMETRY & PATHING UTILITIES
// SVG path generation, grid calculations, and connection bundling
// ============================================================================

/**
 * Bundle connections between the same two artists for parallel line rendering
 * @param {Array} connections - Array of connection objects
 * @returns {Object} Bundles keyed by sorted artist pair
 */
function getBundledConnections(connections) {
  const bundles = {};
  connections.forEach(conn => {
    const key = [conn.from, conn.to].sort().join('-');
    if (!bundles[key]) bundles[key] = [];
    bundles[key].push(conn);
  });
  return bundles;
}

/**
 * Calculate offset for a bundled connection line
 * @param {number} index - Index of this connection in the bundle
 * @param {number} total - Total connections in the bundle
 * @param {number} gap - Gap between parallel lines
 * @returns {number} Pixel offset from center
 */
function getBundleOffset(index, total, gap = LINE_GAP) {
  if (total === 1) return 0;
  return (index - (total - 1) / 2) * gap;
}

/**
 * Generate an SVG path string for an octilinear (metro-style) line
 * Uses only horizontal, vertical, and 45-degree diagonal segments
 * @param {number} x1 - Start X coordinate
 * @param {number} y1 - Start Y coordinate
 * @param {number} x2 - End X coordinate
 * @param {number} y2 - End Y coordinate
 * @param {number} offset - Perpendicular offset for bundled lines
 * @returns {string} SVG path string
 */
function generateOctilinearPath(x1, y1, x2, y2, offset) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  
  const TOLERANCE = 5;
  
  if (ady < TOLERANCE) {
    return `M ${x1} ${y1 + offset} L ${x2} ${y2 + offset}`;
  }
  
  if (adx < TOLERANCE) {
    return `M ${x1 + offset} ${y1} L ${x2 + offset} ${y2}`;
  }
  
  if (Math.abs(adx - ady) < TOLERANCE) {
    const len = Math.sqrt(dx * dx + dy * dy);
    const perpX = (-dy / len) * offset;
    const perpY = (dx / len) * offset;
    return `M ${x1 + perpX} ${y1 + perpY} L ${x2 + perpX} ${y2 + perpY}`;
  }
  
  const signX = dx > 0 ? 1 : -1;
  const signY = dy > 0 ? 1 : -1;
  
  if (adx > ady) {
    const diagPerpX = -signY / Math.sqrt(2);
    const diagPerpY = signX / Math.sqrt(2);
    
    const p1x = x1 + diagPerpX * offset;
    const p1y = y1 + diagPerpY * offset;
    
    const horizOffsetY = offset;
    const p2y = y2 + horizOffsetY;
    
    const slope = signY / signX;
    const cornerX = p1x + (p2y - p1y) / slope;
    const cornerY = p2y;
    
    return `M ${p1x} ${p1y} L ${cornerX} ${cornerY} L ${x2} ${p2y}`;
    
  } else {
    const diagPerpX = -signY / Math.sqrt(2);
    const diagPerpY = signX / Math.sqrt(2);
    
    const p1x = x1 + diagPerpX * offset;
    const p1y = y1 + diagPerpY * offset;
    
    const vertOffsetX = -offset;
    const p2x = x2 + vertOffsetX;
    
    const slope = signY / signX;
    const cornerX = p2x;
    const cornerY = p1y + slope * (p2x - p1x);
    
    return `M ${p1x} ${p1y} L ${cornerX} ${cornerY} L ${p2x} ${y2}`;
  }
}

/**
 * Get the length of an SVG path string (in pixels)
 * @param {string} pathString - SVG path d attribute
 * @returns {number} Path length in pixels
 */
function getPathLength(pathString) {
  const tempSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tempPath.setAttribute('d', pathString);
  tempSvg.appendChild(tempPath);
  document.body.appendChild(tempSvg);
  const length = tempPath.getTotalLength();
  document.body.removeChild(tempSvg);
  return length;
}

// ============================================================================
// 4. DATA PROCESSING
// Functions to extract and process artist data from API responses
// ============================================================================

/**
 * Search for real artists using MusicBrainz API (wrapper with error handling)
 * @param {string} query - Search string
 * @returns {Promise<Array>} Array of simplified artist objects
 */
async function searchRealArtist(query) {
  try {
    const results = await searchMusicBrainzArtist(query);
    return results.map(artist => ({
      id: artist.id,
      name: artist.name,
      type: artist.type,
      disambiguation: artist.disambiguation || '',
      country: artist.country || 'Unknown'
    }));
  } catch (error) {
    console.error('Search error:', error);
    throw error;
  }
}

/**
 * Get full artist details by MBID (wrapper with error handling)
 * @param {string} mbid - MusicBrainz ID
 * @returns {Promise<Object>} Artist details
 */
async function getRealArtistDetails(mbid) {
  try {
    return await getArtistDetails(mbid);
  } catch (error) {
    console.error('Artist details error:', error);
    throw error;
  }
}

/**
 * Extract genres from artist object (combines genres and tags)
 * @param {Object} artist - Artist data from MusicBrainz
 * @returns {string} Comma-separated genres (max 2)
 */
function extractGenres(artist) {
  const genres = new Set();
  
  if (artist.genres) {
    artist.genres.forEach(g => genres.add(g.name));
  }
  if (artist.tags) {
    artist.tags.slice(0, 3).forEach(t => genres.add(t.name));
  }
  
  return Array.from(genres).slice(0, 2).join(', ') || 'Unknown';
}

/**
 * Get the year (YYYY) from artist's life-span
 * @param {Object} artist - Artist data from MusicBrainz
 * @returns {number|null} Year or null if not available
 */
function getArtistYear(artist) {
  if (artist['life-span'] && artist['life-span'].begin) {
    return parseInt(artist['life-span'].begin.split('-')[0]);
  }
  return null;
}

/**
 * Extract works (songs) an artist has written/composed/lyricized
 * @param {Object} artistData - Artist data from MusicBrainz
 * @returns {Array} Array of work objects with id, title, role
 */
function extractWrittenWorks(artistData) {
  const works = [];
  if (!artistData.relations) return works;

  artistData.relations.forEach(rel => {
    // Work relationships - artist wrote/composed a work
    if (rel.work && (rel.type === 'writer' || rel.type === 'composer' || rel.type === 'lyricist')) {
      works.push({
        id: rel.work.id,
        title: rel.work.title,
        role: rel.type
      });
    }
  });

  return works;
}

/**
 * Extract record labels an artist has been signed to
 * @param {Object} artistData - Artist data from MusicBrainz
 * @returns {Array} Array of label objects with id, name, type, years
 */
function extractLabels(artistData) {
  const labels = [];
  if (!artistData.relations) return labels;

  artistData.relations.forEach(rel => {
    if (rel.label) {
      labels.push({
        id: rel.label.id,
        name: rel.label.name,
        type: rel.type,
        years: rel.begin ? (rel.end ? `${rel.begin}-${rel.end}` : `${rel.begin}-`) : ''
      });
    }
  });

  return labels;
}

/**
 * Find artists who share the same record label (labelmates)
 * @param {string} newArtistId - MBID of the new artist
 * @param {Array} newArtistLabels - Labels the new artist is signed to
 * @param {Object} existingArtists - Existing artists on the map
 * @returns {Array} Array of label connection objects
 */
function findSharedLabels(newArtistId, newArtistLabels, existingArtists) {
  const connections = [];
  if (newArtistLabels.length === 0) return connections;

  Object.values(existingArtists).forEach(existingArtist => {
    if (!existingArtist.labels || existingArtist.id === newArtistId) return;

    const sharedLabels = newArtistLabels.filter(newLabel =>
      existingArtist.labels.some(existingLabel => existingLabel.id === newLabel.id)
    );

    if (sharedLabels.length > 0) {
      connections.push({
        from: newArtistId,
        to: existingArtist.id,
        type: 'label',
        data: {
          role: 'Labelmates',
          years: '',
          titles: sharedLabels.map(l => l.name)
        }
      });
    }
  });

  return connections;
}

/**
 * Find co-writers between a new artist and existing artists
 * @param {string} newArtistId - MBID of the new artist
 * @param {Array} newArtistWorks - Works the new artist has written
 * @param {Object} existingArtists - Existing artists on the map
 * @returns {Array} Array of writing connection objects
 */
function findCoWriters(newArtistId, newArtistWorks, existingArtists) {
  const connections = [];

  Object.values(existingArtists).forEach(existingArtist => {
    if (!existingArtist.works || existingArtist.id === newArtistId) return;

    // Find shared works
    const sharedWorks = newArtistWorks.filter(newWork =>
      existingArtist.works.some(existingWork => existingWork.id === newWork.id)
    );

    if (sharedWorks.length > 0) {
      connections.push({
        from: newArtistId,
        to: existingArtist.id,
        type: 'writing',
        data: {
          role: 'Co-Writer',
          years: '',
          titles: sharedWorks.map(w => w.title)
        }
      });
    }
  });

  return connections;
}

/**
 * Process MusicBrainz relationships into app connection objects
 * Extracts member, studio, and writing relationships
 * @param {Object} artistData - Artist data from MusicBrainz
 * @returns {Array} Array of connection objects with type, targetMbid, targetName, data
 */
function processRelationships(artistData) {
  const connections = [];

  if (!artistData.relations) return connections;

  artistData.relations.forEach(rel => {
    // --- Member of band relationships ---
    if (rel.type === 'member of band' && rel.artist) {
      connections.push({
        type: 'member',
        targetMbid: rel.artist.id,
        targetName: rel.artist.name,
        data: {
          role: rel.attributes?.join(', ') || 'Member',
          years: rel.begin && rel.end
            ? `${rel.begin}-${rel.end}`
            : rel.begin ? rel.begin : 'Unknown',
          titles: rel.title ? [rel.title] : null
        }
      });
    }

    // Check for other collaboration types
    if ((rel.type === 'collaboration' || rel.type === 'production') && rel.artist) {
      connections.push({
        type: 'studio',
        targetMbid: rel.artist.id,
        targetName: rel.artist.name,
        data: {
          role: 'Collaboration',
          years: rel.begin ? rel.begin : 'Unknown',
          titles: rel.title ? [rel.title] : null
        }
      });
    }

    // Direct artist-to-artist writing credits (rare but possible)
    if ((rel.type === 'writer' || rel.type === 'composer' || rel.type === 'lyricist' || rel.type === 'songwriter') && rel.artist) {
      connections.push({
        type: 'writing',
        targetMbid: rel.artist.id,
        targetName: rel.artist.name,
        data: {
          role: rel.type.charAt(0).toUpperCase() + rel.type.slice(1),
          years: rel.begin ? rel.begin : 'Unknown',
          titles: rel.title ? [rel.title] : null
        }
      });
    }

    // Label connections are handled separately via findSharedLabels
  });

  return connections;
}


// ============================================================================
// 5. LAYOUT
// Auto-positioning of artists on the transit map grid
// ============================================================================

/**
 * Auto-layout artists in a spiral pattern from center
 * Creates a transit-map-style layout that spreads horizontally
 * @param {Object} artists - Object of artist data keyed by MBID
 * @returns {Object} Artists with x, y positions assigned
 */
function autoLayoutStations(artists) {
  const positioned = {};
  const artistList = Object.values(artists);

  if (artistList.length === 0) return positioned;

  // Sort by year for consistent ordering
  artistList.sort((a, b) => (a.year || 1970) - (b.year || 1970));

  // Spiral outward from center - transit map style
  // Uses a rectangular spiral that spreads wide horizontally
  const occupied = new Set();
  const getKey = (x, y) => `${x},${y}`;

  // Spiral directions: right, down, left, up - but weighted to go wider
  const directions = [
    { dx: 2, dy: 0 },   // right (2 steps for wider spread)
    { dx: 0, dy: 1 },   // down
    { dx: -2, dy: 0 },  // left (2 steps for wider spread)
    { dx: 0, dy: -1 }   // up
  ];

  let x = 0, y = 0;
  let dirIndex = 0;
  let stepsInDir = 0;
  let stepsBeforeTurn = 1;
  let turnCount = 0;

  artistList.forEach((artist, idx) => {
    // Find next unoccupied position
    while (occupied.has(getKey(x, y))) {
      const dir = directions[dirIndex];
      x += dir.dx;
      y += dir.dy;
      stepsInDir++;

      if (stepsInDir >= stepsBeforeTurn) {
        stepsInDir = 0;
        dirIndex = (dirIndex + 1) % 4;
        turnCount++;
        // Increase steps every 2 turns (completed one "ring")
        if (turnCount % 2 === 0) {
          stepsBeforeTurn++;
        }
      }
    }

    positioned[artist.id] = {
      ...artist,
      x: x,
      y: y
    };
    occupied.add(getKey(x, y));

    // Move to next position for next artist
    const dir = directions[dirIndex];
    x += dir.dx;
    y += dir.dy;
    stepsInDir++;

    if (stepsInDir >= stepsBeforeTurn) {
      stepsInDir = 0;
      dirIndex = (dirIndex + 1) % 4;
      turnCount++;
      if (turnCount % 2 === 0) {
        stepsBeforeTurn++;
      }
    }
  });

  return positioned;
}


// ============================================================================
// COLOR & LABEL CONSTANTS
// Theme colors and human-readable labels for connection types
// ============================================================================

/** Line colors for light mode */
const LINE_COLORS_LIGHT = {
  member: '#059669',   // Emerald - Personnel/Band membership
  studio: '#2563eb',   // Blue - Studio collaborations
  writing: '#7c3aed',  // Purple - Writing credits
  label: '#ca8a04',    // Yellow - Record label
  error: '#dc2626',    // Red - UI elements (errors, clear buttons)
};

/** Line colors for dark mode */
const LINE_COLORS_DARK = {
  member: '#10b981',   // Emerald (lighter)
  studio: '#3b82f6',   // Blue (lighter)
  writing: '#a78bfa',  // Purple (lighter)
  label: '#facc15',    // Yellow (lighter)
  error: '#ef4444',    // Red (lighter)
};

/** Human-readable labels for each connection type */
const LINE_LABELS = {
  member: 'Personnel Line',
  studio: 'Studio Line',
  writing: 'Writing Credits',
  label: 'Record Label',
};

/** Perpendicular offset for each line type to prevent overlap */
const LINE_TYPE_OFFSET = {
  member: 0,              // Green - center line
  studio: LINE_GAP,       // Blue - offset to one side
  writing: -LINE_GAP,     // Purple - offset to opposite side
  label: LINE_GAP * 1.5,  // Yellow - further offset
};

/**
 * Convert grid coordinates to pixel coordinates for SVG rendering
 * @param {number} gridX - Grid X position
 * @param {number} gridY - Grid Y position
 * @returns {{x: number, y: number}} Pixel coordinates
 */
const gridToPixel = (gridX, gridY) => ({
  x: gridX * GRID_SIZE,
  y: gridY * GRID_SIZE
});

/**
 * Find the shortest path between two artists using DFS
 * @param {Object} graph - Graph with artists and connections
 * @param {string} startId - Starting artist MBID
 * @param {string} endId - Ending artist MBID
 * @param {number} maxDepth - Maximum path length to search
 * @returns {Array|null} Shortest path as array of steps, or null if none found
 */
function findAllPaths(graph, startId, endId, maxDepth = 6) {
  if (!startId || !endId || startId === endId) return null;
  
  const allPaths = [];
  const visited = new Set();
  
  function dfs(currentId, path, depth) {
    if (depth > maxDepth) return;
    if (currentId === endId) {
      allPaths.push([...path]);
      return;
    }
    
    visited.add(currentId);
    
    graph.connections.forEach(conn => {
      let nextId = null;
      if (conn.from === currentId && !visited.has(conn.to)) {
        nextId = conn.to;
      } else if (conn.to === currentId && !visited.has(conn.from)) {
        nextId = conn.from;
      }
      
      if (nextId) {
        path.push({ conn, artistId: nextId });
        dfs(nextId, path, depth + 1);
        path.pop();
      }
    });
    
    visited.delete(currentId);
  }
  
  dfs(startId, [], 0);
  
  if (allPaths.length === 0) return null;
  
  allPaths.sort((a, b) => a.length - b.length);
  return allPaths[0];
}


// ============================================================================
// 6. MAIN COMPONENT
// React component with state management, event handlers, and UI rendering
// ============================================================================

export default function Counterpoint() {
  // ────────────────────────────────────────────────────────────────
  // 6.1 STATE: All useState/useRef hooks
  // ────────────────────────────────────────────────────────────────

  // UI theme
  const [darkMode, setDarkMode] = useState(true);

  // Main graph data: artists and their connections
  const [graph, setGraph] = useState({ artists: {}, connections: [] });

  // Selection state
  const [selectedStation, setSelectedStation] = useState(null);   // Selected artist
  const [hoveredStation, setHoveredStation] = useState(null);     // Hovered artist
  const [selectedConnection, setSelectedConnection] = useState(null); // Selected line

  // Route-finding state
  const [startStation, setStartStation] = useState(null);
  const [endStation, setEndStation] = useState(null);
  const [route, setRoute] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null);

  // Loading state
  const [loadingArtists, setLoadingArtists] = useState(new Set());
  const [isExploring, setIsExploring] = useState(false);

  // UI visibility
  const [showSearch, setShowSearch] = useState(true);

  // SVG viewport and panning
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 800, height: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // ────────────────────────────────────────────────────────────────
  // 6.2 DERIVED VALUES: Theme colors and memoized calculations
  // ────────────────────────────────────────────────────────────────

  const LINE_COLORS = darkMode ? LINE_COLORS_DARK : LINE_COLORS_LIGHT;
  const backgroundColor = darkMode ? '#000000' : '#ffffff';
  const textColor = darkMode ? '#ffffff' : '#000000';
  const mutedText = darkMode ? '#9ca3af' : '#6b7280';
  const borderColor = darkMode ? '#333333' : '#e5e7eb';

  // Bundle connections for parallel line calculation (memoized)
  const bundledConnections = useMemo(() => {
    return getBundledConnections(graph.connections);
  }, [graph.connections]);

  // ────────────────────────────────────────────────────────────────
  // 6.3 HANDLERS: Search, add artist, explore connections
  // ────────────────────────────────────────────────────────────────

  /**
   * Search for artists using MusicBrainz API
   * Updates searchResults state with matching artists
   */
  const handleSearch = async () => {
  if (!searchQuery.trim()) return;
  
  setIsSearching(true);
  setError(null);
  
  try {
    const results = await searchRealArtist(searchQuery);
    setSearchResults(results);
  } catch (err) {
    setError('Failed to search artists. Please try again.');
    console.error(err);
  } finally {
    setIsSearching(false);
  }
};

  /**
   * Add an artist to the graph by MBID
   * Fetches artist details, processes relationships, and creates connections
   * @param {string} mbid - MusicBrainz ID
   * @param {string} name - Artist name (for display during loading)
   */
  const addArtistToGraph = async (mbid, name) => {
    if (graph.artists[mbid]) {
      setError('Artist already added to the map');
      return;
    }

    setLoadingArtists(prev => new Set(prev).add(mbid));
    setError(null);

    try {
      const artistData = await getRealArtistDetails(mbid);
      if (!artistData) {
        setError('Artist not found');
        return;
      }

      const year = getArtistYear(artistData);
      const genres = extractGenres(artistData);
      const works = extractWrittenWorks(artistData);
      const labels = extractLabels(artistData);

      // Fetch artist image from Wikidata
      const wikidataId = extractWikidataId(artistData);
      const imageUrl = await fetchWikidataImage(wikidataId);

      const hubPosition = calculateHubPosition(artistData);

      const newArtist = {
        id: mbid,
        name: artistData.name,
        type: artistData.type || 'artist',
        year: year,
        genre: genres,
        works: works,
        labels: labels,
        imageUrl: imageUrl,
        x: hubPosition.x,
        y: hubPosition.y
      };

      const connections = processRelationships(artistData);

      const newConnections = [];
      connections.forEach(conn => {
        if (graph.artists[conn.targetMbid]) {
          newConnections.push({
            from: mbid,
            to: conn.targetMbid,
            type: conn.type,
            data: conn.data
          });
        }
      });

      // Find co-writers based on shared works
      const coWriterConnections = findCoWriters(mbid, works, graph.artists);
      newConnections.push(...coWriterConnections);

      // Find labelmates based on shared labels
      const labelConnections = findSharedLabels(mbid, labels, graph.artists);
      newConnections.push(...labelConnections);

      const updatedArtists = {
        ...graph.artists,
        [mbid]: newArtist
      };

      const layouted = autoLayoutStations(updatedArtists);

      setGraph({
        artists: layouted,
        connections: [...graph.connections, ...newConnections]
      });

      setSearchQuery('');
      setSearchResults([]);

    } catch (err) {
      setError('Failed to add artist. Please try again.');
      console.error(err);
    } finally {
      setLoadingArtists(prev => {
        const next = new Set(prev);
        next.delete(mbid);
        return next;
      });
    }
  };

  /**
   * Explore connections from an existing artist on the map
   * Fetches related artists and adds them with their connections
   * @param {string} mbid - MusicBrainz ID of the artist to explore from
   */
  const exploreConnections = async (mbid) => {
    if (!graph.artists[mbid] || isExploring) return;

    setIsExploring(true);
    setLoadingArtists(prev => new Set(prev).add(mbid));
    setError(null);

    try {
      const artistData = await getRealArtistDetails(mbid);
      if (!artistData) return;

      // Update current artist's works and labels
      const currentWorks = extractWrittenWorks(artistData);
      const currentLabels = extractLabels(artistData);

      const connections = processRelationships(artistData);

      const newArtists = {};
      const newConnections = [];

      for (const conn of connections) {
        if (!graph.artists[conn.targetMbid] && !newArtists[conn.targetMbid]) {
          try {
            const relatedData = await getRealArtistDetails(conn.targetMbid);
            if (!relatedData) continue;

            const year = getArtistYear(relatedData);
            const genres = extractGenres(relatedData);
            const works = extractWrittenWorks(relatedData);
            const labels = extractLabels(relatedData);
            const hubPosition = calculateHubPosition(relatedData);

            // Fetch artist image from Wikidata
            const wikidataId = extractWikidataId(relatedData);
            const imageUrl = await fetchWikidataImage(wikidataId);

            newArtists[conn.targetMbid] = {
              id: conn.targetMbid,
              name: conn.targetName,
              type: relatedData.type || 'artist',
              year: year,
              genre: genres,
              works: works,
              labels: labels,
              imageUrl: imageUrl,
              x: hubPosition.x,
              y: hubPosition.y
            };
          } catch (err) {
            console.error(`Failed to fetch ${conn.targetName}:`, err);
            continue;
          }
        }

        const isDuplicate = graph.connections.some(
          c => (c.from === mbid && c.to === conn.targetMbid) ||
               (c.from === conn.targetMbid && c.to === mbid)
        ) || newConnections.some(
          c => (c.from === mbid && c.to === conn.targetMbid) ||
               (c.from === conn.targetMbid && c.to === mbid)
        );

        if (!isDuplicate) {
          newConnections.push({
            from: mbid,
            to: conn.targetMbid,
            type: conn.type,
            data: conn.data
          });
        }
      }

      // Merge existing artists with new ones for co-writer/labelmate search
      const allArtists = {
        ...graph.artists,
        ...newArtists
      };

      // Update current artist with works and labels
      allArtists[mbid] = {
        ...allArtists[mbid],
        works: currentWorks,
        labels: currentLabels
      };

      // Helper to check for duplicate connections
      const isDuplicateConn = (conn, type) => {
        return graph.connections.some(
          c => (c.from === conn.from && c.to === conn.to && c.type === type) ||
               (c.from === conn.to && c.to === conn.from && c.type === type)
        ) || newConnections.some(
          c => (c.from === conn.from && c.to === conn.to && c.type === type) ||
               (c.from === conn.to && c.to === conn.from && c.type === type)
        );
      };

      // Find co-writers for current artist
      const coWriterConnections = findCoWriters(mbid, currentWorks, allArtists);
      coWriterConnections.forEach(conn => {
        if (!isDuplicateConn(conn, 'writing')) {
          newConnections.push(conn);
        }
      });

      // Find labelmates for current artist
      const labelConnections = findSharedLabels(mbid, currentLabels, allArtists);
      labelConnections.forEach(conn => {
        if (!isDuplicateConn(conn, 'label')) {
          newConnections.push(conn);
        }
      });

      // Also find co-writers and labelmates for each new artist
      Object.values(newArtists).forEach(newArtist => {
        if (newArtist.works && newArtist.works.length > 0) {
          const artistCoWriters = findCoWriters(newArtist.id, newArtist.works, allArtists);
          artistCoWriters.forEach(conn => {
            if (!isDuplicateConn(conn, 'writing')) {
              newConnections.push(conn);
            }
          });
        }
        if (newArtist.labels && newArtist.labels.length > 0) {
          const artistLabelmates = findSharedLabels(newArtist.id, newArtist.labels, allArtists);
          artistLabelmates.forEach(conn => {
            if (!isDuplicateConn(conn, 'label')) {
              newConnections.push(conn);
            }
          });
        }
      });

      const layouted = autoLayoutStations(allArtists);

      setGraph({
        artists: layouted,
        connections: [...graph.connections, ...newConnections]
      });

    } catch (err) {
      setError('Failed to explore connections. Please try again.');
      console.error(err);
    } finally {
      setIsExploring(false);
      setLoadingArtists(prev => {
        const next = new Set(prev);
        next.delete(mbid);
        return next;
      });
    }
  };

  // ────────────────────────────────────────────────────────────────
  // 6.4 EFFECTS: Route calculation
  // ────────────────────────────────────────────────────────────────

  /** Calculate route when start/end stations change */
  useEffect(() => {
    if (startStation && endStation && startStation !== endStation) {
      const path = findAllPaths(graph, startStation, endStation);
      setRoute(path);
    } else {
      setRoute(null);
    }
  }, [startStation, endStation, graph]);

  // ────────────────────────────────────────────────────────────────
  // 6.5 PAN & ZOOM HANDLERS: Mouse events for map navigation
  // ────────────────────────────────────────────────────────────────

  /** Handle mouse down for panning */
  const handleMouseDown = (e) => {
    if (e.button === 0) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  };

  /** Handle mouse move for panning */
  const handleMouseMove = (e) => {
    if (isPanning) {
      const dx = (e.clientX - panStart.x) * 1.5;
      const dy = (e.clientY - panStart.y) * 1.5;
      setViewBox(prev => ({
        ...prev,
        x: prev.x - dx,
        y: prev.y - dy
      }));
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  };

  /** Handle mouse up to stop panning */
  const handleMouseUp = () => {
    setIsPanning(false);
  };

  /** Handle mouse wheel for zooming */
  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1.1 : 0.9;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setViewBox(prev => {
      const newWidth = prev.width * delta;
      const newHeight = prev.height * delta;
      return {
        x: prev.x + (x / rect.width) * (prev.width - newWidth),
        y: prev.y + (y / rect.height) * (prev.height - newHeight),
        width: newWidth,
        height: newHeight
      };
    });
  };

  // ────────────────────────────────────────────────────────────────
  // 6.6 HELPER FUNCTIONS: Route checking
  // ────────────────────────────────────────────────────────────────

  /** Check if a connection is part of the current route */
  const isConnectionInRoute = (conn) => {
    if (!route) return false;
    return route.some(step => 
      (step.conn.from === conn.from && step.conn.to === conn.to) ||
      (step.conn.from === conn.to && step.conn.to === conn.from)
    );
  };

  // ────────────────────────────────────────────────────────────────
  // 6.7 RENDER: Main component JSX
  // ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      background: backgroundColor,
      color: textColor,
      overflow: 'hidden'
    }}>
      {/* Left Panel */}
      <div style={{
        width: showSearch ? '350px' : '0px',
        height: '100%',
        background: darkMode ? '#0a0a0a' : '#f9fafb',
        borderRight: `2px solid ${borderColor}`,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.3s ease',
        overflow: 'hidden'
      }}>
        <div style={{
          padding: '20px',
          borderBottom: `2px solid ${borderColor}`,
          background: darkMode ? '#000000' : '#ffffff'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <Music size={24} />
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', margin: 0 }}>COUNTERPOINT</h1>
          </div>
          <p style={{ fontSize: '12px', color: mutedText, margin: 0 }}>
            Transit-style music history map
          </p>
        </div>

        <div style={{ padding: '16px', borderBottom: `2px solid ${borderColor}` }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search (Beatles, Yardbirds, Dylan)..."
              style={{
                flex: 1,
                padding: '10px 12px',
                background: darkMode ? '#1a1a1a' : '#ffffff',
                border: `2px solid ${borderColor}`,
                borderRadius: '4px',
                color: textColor,
                fontSize: '13px',
                outline: 'none'
              }}
            />
            <button
              onClick={handleSearch}
              disabled={isSearching || !searchQuery.trim()}
              style={{
                padding: '10px 16px',
                background: LINE_COLORS.member,
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: isSearching ? 'not-allowed' : 'pointer',
                opacity: isSearching ? 0.5 : 1
              }}
            >
              {isSearching ? <Loader size={16} /> : <Search size={16} />}
            </button>
          </div>

          {error && (
            <div style={{
              padding: '12px',
              background: darkMode ? '#1a0000' : '#fef2f2',
              border: `2px solid ${LINE_COLORS.error}`,
              borderRadius: '4px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: LINE_COLORS.error
            }}>
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {searchResults.length > 0 && (
            <div style={{
              marginTop: '12px',
              maxHeight: '300px',
              overflowY: 'auto',
              border: `2px solid ${borderColor}`,
              borderRadius: '4px',
              background: darkMode ? '#1a1a1a' : '#ffffff'
            }}>
              {searchResults.map((artist, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    borderBottom: idx < searchResults.length - 1 ? `1px solid ${borderColor}` : 'none',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onClick={() => addArtistToGraph(artist.id, artist.name)}
                >
                  <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '4px' }}>
                    {artist.name}
                  </div>
                  <div style={{ fontSize: '11px', color: mutedText }}>
                    {artist.type} • {artist['life-span']?.begin?.split('-')[0]}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '12px', fontWeight: 'bold', margin: 0 }}>
              ON MAP ({Object.keys(graph.artists).length})
            </h3>
            {Object.keys(graph.artists).length > 0 && (
              <button
                onClick={() => {
                  setGraph({ artists: {}, connections: [] });
                  setSelectedStation(null);
                  setStartStation(null);
                  setEndStation(null);
                  setRoute(null);
                }}
                style={{
                  padding: '4px 8px',
                  fontSize: '10px',
                  background: 'transparent',
                  color: LINE_COLORS.error,
                  border: `1px solid ${LINE_COLORS.error}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                RESET
              </button>
            )}
          </div>
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '6px',
            maxHeight: 'calc(100vh - 400px)',
            overflowY: 'auto',
            paddingRight: '4px'
          }}>
            <style>{`
              div::-webkit-scrollbar {
                width: 8px;
              }
              div::-webkit-scrollbar-track {
                background: ${darkMode ? '#000000' : '#f1f1f1'};
              }
              div::-webkit-scrollbar-thumb {
                background: ${darkMode ? '#333333' : '#888888'};
                border-radius: 4px;
              }
              div::-webkit-scrollbar-thumb:hover {
                background: ${darkMode ? '#555555' : '#555555'};
              }
            `}</style>
            {Object.values(graph.artists).sort((a, b) => a.name.localeCompare(b.name)).map(artist => (
              <div
                key={artist.id}
                onClick={() => setSelectedStation(artist)}
                style={{
                  padding: '10px',
                  background: selectedStation?.id === artist.id ? LINE_COLORS.member : (darkMode ? '#1a1a1a' : '#ffffff'),
                  border: `2px solid ${selectedStation?.id === artist.id ? LINE_COLORS.member : borderColor}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: selectedStation?.id === artist.id ? '#ffffff' : textColor
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 'bold' }}>{artist.name}</div>
                <div style={{ fontSize: '10px', color: selectedStation?.id === artist.id ? 'rgba(255,255,255,0.8)' : mutedText }}>
                  {artist.genre} • {artist.year}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: '16px', borderTop: `2px solid ${borderColor}`, background: darkMode ? '#000000' : '#ffffff' }}>
          <button
            onClick={() => setDarkMode(!darkMode)}
            style={{
              width: '100%',
              padding: '12px',
              background: darkMode ? '#1a1a1a' : '#ffffff',
              border: `2px solid ${borderColor}`,
              borderRadius: '4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              color: textColor
            }}
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            {darkMode ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>
      </div>

      {/* Main Map */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <button
          onClick={() => setShowSearch(!showSearch)}
          style={{
            position: 'absolute',
            top: '16px',
            left: '16px',
            zIndex: 10,
            padding: '10px',
            background: darkMode ? '#1a1a1a' : '#ffffff',
            border: `2px solid ${borderColor}`,
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          {showSearch ? <X size={20} /> : <Search size={20} />}
        </button>

        {/* Exploring Connections Overlay */}
        {isExploring && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: darkMode ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            backdropFilter: 'blur(2px)'
          }}>
            <div style={{
              background: darkMode ? '#1a1a1a' : '#ffffff',
              border: `2px solid ${LINE_COLORS.studio}`,
              borderRadius: '8px',
              padding: '24px 32px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
            }}>
              <Loader size={24} style={{ color: LINE_COLORS.studio, animation: 'spin 1s linear infinite' }} />
              <div>
                <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '4px' }}>
                  Exploring Connections
                </div>
                <div style={{ fontSize: '12px', color: mutedText }}>
                  Fetching related artists from MusicBrainz...
                </div>
              </div>
            </div>
          </div>
        )}

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>

        <div style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          zIndex: 10,
          background: darkMode ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)',
          border: `2px solid ${borderColor}`,
          borderRadius: '4px',
          padding: '12px',
          fontSize: '11px'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>LEGEND</div>
          {Object.entries(LINE_LABELS).map(([type, label]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <div style={{ width: '20px', height: '4px', background: LINE_COLORS[type] }} />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {/* Route Info - positioned below legend */}
        {route && (
          <div style={{
            position: 'absolute',
            top: '190px',
            right: '16px',
            zIndex: 10,
            background: darkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)',
            border: `2px solid ${LINE_COLORS.member}`,
            borderRadius: '4px',
            padding: '12px',
            fontSize: '11px',
            maxWidth: '280px',
            maxHeight: '400px',
            overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Navigation size={16} style={{ color: LINE_COLORS.member }} />
              <div style={{ fontWeight: 'bold' }}>Route Active</div>
            </div>
            <div style={{ fontSize: '10px', color: mutedText, marginBottom: '12px' }}>
              {graph.artists[startStation]?.name} → {graph.artists[endStation]?.name}
            </div>
            
            {/* Route Steps */}
            <div style={{ fontSize: '10px', marginBottom: '12px' }}>
              {route.map((step, idx) => {
                const conn = step.conn;
                const artist = graph.artists[step.artistId];
                const lineColor = LINE_COLORS[conn.type];
                const lineLabel = LINE_LABELS[conn.type];
                
                return (
                  <div key={idx} style={{ marginBottom: '8px', paddingBottom: '8px', borderBottom: idx < route.length - 1 ? `1px solid ${borderColor}` : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <div style={{ width: '16px', height: '3px', background: lineColor }} />
                      <span style={{ fontWeight: 'bold', fontSize: '9px', color: lineColor }}>
                        {lineLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: textColor }}>
                      → {artist?.name}
                    </div>
                    {conn.data && (
                      <div style={{ fontSize: '9px', color: mutedText, marginTop: '2px' }}>
                        {conn.data.role || conn.data.event || ''} {conn.data.years || conn.data.date || ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            
            <button
              onClick={() => {
                setStartStation(null);
                setEndStation(null);
                setRoute(null);
              }}
              style={{
                padding: '8px 12px',
                background: LINE_COLORS.error,
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px',
                fontWeight: 'bold',
                width: '100%'
              }}
            >
              Clear Route
            </button>
          </div>
        )}

        {/* No Route Found Panel */}
        {!route && startStation && endStation && startStation !== endStation && (
          <div style={{
            position: 'absolute',
            top: '190px',
            right: '16px',
            zIndex: 10,
            background: darkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)',
            border: `2px solid ${LINE_COLORS.error}`,
            borderRadius: '4px',
            padding: '12px',
            fontSize: '11px',
            maxWidth: '280px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <AlertCircle size={16} style={{ color: LINE_COLORS.error }} />
              <div style={{ fontWeight: 'bold' }}>No Route Found</div>
            </div>
            <div style={{ fontSize: '10px', color: mutedText, marginBottom: '12px' }}>
              {graph.artists[startStation]?.name} → {graph.artists[endStation]?.name}
            </div>
            
            <div style={{ 
              fontSize: '10px', 
              color: textColor, 
              marginBottom: '12px',
              padding: '10px',
              background: darkMode ? '#1a1a1a' : '#f9fafb',
              borderRadius: '4px',
              border: `1px solid ${borderColor}`
            }}>
              No connection path exists between these artists in the current database. They may have operated in separate musical circles or eras.
            </div>
            
            <button
              onClick={() => {
                setStartStation(null);
                setEndStation(null);
                setRoute(null);
              }}
              style={{
                padding: '8px 12px',
                background: LINE_COLORS.error,
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px',
                fontWeight: 'bold',
                width: '100%'
              }}
            >
              Clear Route
            </button>
          </div>
        )}

        {/* Connection Details Panel */}
        {selectedConnection && (() => {
          // Find all connections between these two artists
          const allConnections = graph.connections.filter(conn => 
            (conn.from === selectedConnection.from && conn.to === selectedConnection.to) ||
            (conn.from === selectedConnection.to && conn.to === selectedConnection.from)
          );

          return (
            <div style={{
              position: 'absolute',
              top: route ? '610px' : '190px',
              right: '16px',
              zIndex: 10,
              background: darkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)',
              border: `2px solid ${LINE_COLORS[selectedConnection.type]}`,
              borderRadius: '4px',
              padding: '12px',
              fontSize: '11px',
              maxWidth: '280px',
              maxHeight: '400px',
              overflowY: 'auto'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
                  Connection Details
                </div>
                <button 
                  onClick={() => setSelectedConnection(null)} 
                  style={{ 
                    background: 'none', 
                    border: 'none', 
                    cursor: 'pointer', 
                    color: mutedText,
                    padding: '2px'
                  }}
                >
                  <X size={16} />
                </button>
              </div>

              <div style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: `1px solid ${borderColor}` }}>
                <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '4px', color: textColor }}>
                  {graph.artists[selectedConnection.from]?.name}
                </div>
                <div style={{ fontSize: '10px', color: mutedText, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span>↕</span>
                  <span>{allConnections.length} connection{allConnections.length !== 1 ? 's' : ''}</span>
                </div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: textColor }}>
                  {graph.artists[selectedConnection.to]?.name}
                </div>
              </div>

              {/* Show all connections between these artists */}
              {allConnections.map((conn, idx) => (
                <div key={idx} style={{
                  marginBottom: '12px',
                  paddingBottom: '12px',
                  borderBottom: idx < allConnections.length - 1 ? `1px solid ${borderColor}` : 'none'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <div style={{ width: '24px', height: '4px', background: LINE_COLORS[conn.type], borderRadius: '2px' }} />
                    <div style={{ fontWeight: 'bold', color: LINE_COLORS[conn.type], fontSize: '11px' }}>
                      {LINE_LABELS[conn.type]}
                    </div>
                  </div>

                  {conn.data && (
                    <div style={{ 
                      background: darkMode ? '#1a1a1a' : '#f9fafb',
                      border: `1px solid ${borderColor}`,
                      borderRadius: '4px',
                      padding: '10px',
                      fontSize: '10px'
                    }}>
                      {conn.data.titles && conn.data.titles.length > 0 && (
                        <div style={{ 
                          marginBottom: '8px',
                          paddingBottom: '8px',
                          borderBottom: `1px solid ${borderColor}`
                        }}>
                          <span style={{ color: mutedText, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>
                            {conn.type === 'member' ? 'Albums/Projects' : 
                             conn.type === 'studio' ? 'Works' : 
                             'Performances'} ({conn.data.titles.length})
                          </span>
                          <div style={{ 
                            maxHeight: '150px',
                            overflowY: 'auto',
                            paddingRight: '4px'
                          }}>
                            {conn.data.titles.map((title, titleIdx) => (
                              <div key={titleIdx} style={{ 
                                color: LINE_COLORS[conn.type], 
                                fontSize: '11px',
                                marginBottom: '4px',
                                paddingLeft: '8px',
                                borderLeft: `2px solid ${LINE_COLORS[conn.type]}`,
                                fontStyle: 'italic'
                              }}>
                                {title}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {conn.data.role && (
                        <div style={{ marginBottom: '4px' }}>
                          <span style={{ color: mutedText }}>Role: </span>
                          <span style={{ color: textColor, fontWeight: 'bold' }}>
                            {conn.data.role}
                          </span>
                        </div>
                      )}
                      {conn.data.event && (
                        <div style={{ marginBottom: '4px' }}>
                          <span style={{ color: mutedText }}>Event: </span>
                          <span style={{ color: textColor, fontWeight: 'bold' }}>
                            {conn.data.event}
                          </span>
                        </div>
                      )}
                      {(conn.data.years || conn.data.date) && (
                        <div>
                          <span style={{ color: mutedText }}>Period: </span>
                          <span style={{ color: textColor, fontWeight: 'bold' }}>
                            {conn.data.years || conn.data.date}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              <div style={{ 
                marginTop: '12px', 
                fontSize: '9px', 
                color: mutedText, 
                fontStyle: 'italic',
                textAlign: 'center'
              }}>
                Click connection again to deselect
              </div>
            </div>
          );
        })()}

        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          style={{ cursor: isPanning ? 'grabbing' : 'grab', background: backgroundColor }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          <defs>
            <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
              <path
                d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
                fill="none"
                stroke={darkMode ? '#1a1a1a' : '#f3f4f6'}
                strokeWidth="1"
              />
            </pattern>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          <rect width="10000" height="10000" fill="url(#grid)" />

          {/* CONNECTIONS LAYER */}
          {graph.connections.map((conn, idx) => {
            const from = graph.artists[conn.from];
            const to = graph.artists[conn.to];
            if (!from || !to) return null;

            const fromPos = gridToPixel(from.x, from.y);
            const toPos = gridToPixel(to.x, to.y);

            const bundleKey = [conn.from, conn.to].sort().join('-');
            const bundle = bundledConnections[bundleKey];
            const bundleIndex = bundle.indexOf(conn);
            const bundleTotal = bundle.length;

            // Combine global type offset with bundle offset
            const bundleOffset = getBundleOffset(bundleIndex, bundleTotal, LINE_GAP);
            const typeOffset = LINE_TYPE_OFFSET[conn.type] || 0;
            const totalOffset = typeOffset + bundleOffset;
            
            const pathD = generateOctilinearPath(fromPos.x, fromPos.y, toPos.x, toPos.y, totalOffset);
            
            const isInRoute = isConnectionInRoute(conn);
            const isHovered = selectedConnection === conn;
            const isDimmed = selectedConnection && selectedConnection !== conn;

            return (
              <g key={idx} style={{ transition: 'opacity 0.3s ease' }}>
                {/* Transparent Hit Area */}
                <path
                  d={pathD}
                  stroke="transparent"
                  strokeWidth={20}
                  fill="none"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedConnection(selectedConnection === conn ? null : conn);
                  }}
                  style={{ cursor: 'pointer' }}
                />

                {/* Visible Line */}
                <path
                  d={pathD}
                  stroke={isInRoute ? '#ffffff' : LINE_COLORS[conn.type]}
                  strokeWidth={isInRoute ? 6 : (isHovered ? 6 : 4)}
                  fill="none"
                  opacity={isInRoute ? 1 : (isDimmed ? 0.2 : 0.8)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transition: 'stroke 0.3s ease, stroke-width 0.3s ease, opacity 0.3s ease',
                    pointerEvents: 'none'
                  }}
                />
              </g>
            );
          })}

          {/* STATIONS LAYER */}
          {Object.values(graph.artists).map(artist => {
            const pos = gridToPixel(artist.x, artist.y);
            const isSelected = selectedStation?.id === artist.id;
            const isHovered = hoveredStation?.id === artist.id;
            const isStart = startStation === artist.id;
            const isEnd = endStation === artist.id;
            const isInRoute = route?.some(step => step.artistId === artist.id);
            const showLabel = isSelected || isHovered;

            return (
              <g key={artist.id} style={{ transition: 'opacity 0.3s ease, transform 0.3s ease' }}>
                {/* White outline */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={STATION_RADIUS + 3}
                  fill={backgroundColor}
                  stroke="none"
                  style={{ transition: 'all 0.3s ease' }}
                />
                {/* Main station circle */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={STATION_RADIUS}
                  fill={isStart ? LINE_COLORS.member : (isEnd ? '#dc2626' : (isSelected ? '#ffffff' : backgroundColor))}
                  stroke={isStart ? LINE_COLORS.member : (isEnd ? '#dc2626' : (isSelected ? '#ffffff' : (isInRoute ? '#ffffff' : borderColor)))}
                  strokeWidth={isInRoute || isStart || isEnd ? 5 : 4}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedStation(selectedStation?.id === artist.id ? null : artist);
                  }}
                  onDoubleClick={() => exploreConnections(artist.id)}
                  onMouseEnter={() => setHoveredStation(artist)}
                  onMouseLeave={() => setHoveredStation(null)}
                  style={{ cursor: 'pointer', transition: 'all 0.3s ease' }}
                />
                {/* Label - only show on hover or selection */}
                {showLabel && (
                  <text
                    x={pos.x}
                    y={pos.y - 30}
                    textAnchor="middle"
                    fontSize="15"
                    fontWeight="bold"
                    fill={textColor}
                    style={{ pointerEvents: 'none', userSelect: 'none', transition: 'opacity 0.2s ease' }}
                  >
                    {artist.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {selectedStation && (
          <div style={{
            position: 'absolute',
            bottom: '16px',
            right: '16px',
            width: '320px',
            background: darkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)',
            border: `2px solid ${borderColor}`,
            borderRadius: '4px',
            padding: '16px',
            transition: 'all 0.3s ease'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flex: 1 }}>
                {/* Artist Image */}
                {selectedStation.imageUrl && (
                  <img
                    src={selectedStation.imageUrl}
                    alt={selectedStation.name}
                    style={{
                      width: '60px',
                      height: '60px',
                      borderRadius: '4px',
                      objectFit: 'cover',
                      border: `2px solid ${borderColor}`
                    }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedStation.name}
                  </h3>
                  <div style={{ fontSize: '11px', color: mutedText }}>
                    {selectedStation.type} • {selectedStation.genre} • {selectedStation.year}
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedStation(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: mutedText, marginLeft: '8px' }}>
                <X size={18} />
              </button>
            </div>

            {/* Route Selection Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <button
                onClick={() => setStartStation(selectedStation.id)}
                style={{
                  padding: '10px',
                  background: startStation === selectedStation.id ? LINE_COLORS.member : (darkMode ? '#1a1a1a' : '#ffffff'),
                  color: startStation === selectedStation.id ? '#ffffff' : textColor,
                  border: `2px solid ${startStation === selectedStation.id ? LINE_COLORS.member : borderColor}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  letterSpacing: '0.05em'
                }}
              >
                {startStation === selectedStation.id ? '✓ START' : 'SET START'}
              </button>
              <button
                onClick={() => setEndStation(selectedStation.id)}
                style={{
                  padding: '10px',
                  background: endStation === selectedStation.id ? '#dc2626' : (darkMode ? '#1a1a1a' : '#ffffff'),
                  color: endStation === selectedStation.id ? '#ffffff' : textColor,
                  border: `2px solid ${endStation === selectedStation.id ? '#dc2626' : borderColor}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  letterSpacing: '0.05em'
                }}
              >
                {endStation === selectedStation.id ? '✓ END' : 'SET END'}
              </button>
            </div>

            <button
              onClick={() => exploreConnections(selectedStation.id)}
              disabled={loadingArtists.has(selectedStation.id)}
              style={{
                width: '100%',
                padding: '10px',
                background: LINE_COLORS.studio,
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: loadingArtists.has(selectedStation.id) ? 'not-allowed' : 'pointer',
                opacity: loadingArtists.has(selectedStation.id) ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              {loadingArtists.has(selectedStation.id) ? (
                <>
                  <Loader size={14} />
                  Exploring...
                </>
              ) : (
                <>
                  <Plus size={14} />
                  Explore Connections
                </>
              )}
            </button>

            <div style={{ marginTop: '12px', fontSize: '10px', color: mutedText, fontStyle: 'italic' }}>
              Double-click station to explore
            </div>
          </div>
        )}

        {Object.keys(graph.artists).length === 0 && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: mutedText
          }}>
            <Music size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
            <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' }}>
              Start Exploring
            </div>
            <div style={{ fontSize: '13px' }}>
              Try: Beatles, Yardbirds, Clapton, Dylan
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
