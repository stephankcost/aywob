import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Music, Sun, Moon, Search, Loader, AlertCircle, Plus, X, Navigation } from 'lucide-react';

// Transit map uses hub-based layout - artists cluster around three district hubs
const GRID_SIZE = 150;
const STATION_RADIUS = 20; // Increased from 14 for better visibility
const LINE_GAP = 16; // Gap between parallel lines

// Hub positions (asymmetric city layout, not perfect triangle)
// These are transfer junctions, not artist nodes
const HUBS = {
  personnel: { x: -3, y: -2 },  // Northwest - "Band District"
  studio: { x: 4, y: 2 },        // Southeast - "Recording District"  
  tour: { x: 2, y: -4 },         // Northeast - "Performance District"
};

// Calculate artist position based on connection type weights
function calculateHubPosition(artistData) {
  if (!artistData.relations || artistData.relations.length === 0) {
    return { x: 0, y: 0 }; // Default center if no connections
  }

  // Count connection types
  const weights = { member: 0, studio: 0, tour: 0 };
  artistData.relations.forEach(rel => {
    const type = rel.type === 'member of band' ? 'member' : 
                 rel.type === 'collaboration' ? 'studio' : 
                 rel.type === 'performance' ? 'tour' : null;
    if (type) weights[type]++;
  });

  const total = weights.member + weights.studio + weights.tour;
  if (total === 0) return { x: 0, y: 0 };

  // Weighted average of hub positions
  const x = (
    (weights.member / total) * HUBS.personnel.x +
    (weights.studio / total) * HUBS.studio.x +
    (weights.tour / total) * HUBS.tour.x
  );
  
  const y = (
    (weights.member / total) * HUBS.personnel.y +
    (weights.studio / total) * HUBS.studio.y +
    (weights.tour / total) * HUBS.tour.y
  );

  // Snap to grid (round to nearest integer)
  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

// REAL MUSICBRAINZ API
const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const APP_NAME = 'Counterpoint';
const APP_VERSION = '1.0.0';
const CONTACT = 'your-email@example.com'; // Replace with your email

// Rate limiting - MusicBrainz requires 1 request per second
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

// Search for artists
async function searchMusicBrainzArtist(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `${MUSICBRAINZ_API}/artist?query=${encodedQuery}&fmt=json&limit=10`;
  const data = await rateLimitedFetch(url);
  return data.artists || [];
}

// Get artist details with relationships
async function getArtistDetails(mbid) {
  const url = `${MUSICBRAINZ_API}/artist/${mbid}?inc=artist-rels+recording-rels+work-rels+url-rels+genres+tags&fmt=json`;
  return await rateLimitedFetch(url);
}

// --- GEOMETRY & PATHING UTILITIES ---

function getBundledConnections(connections) {
  const bundles = {};
  connections.forEach(conn => {
    const key = [conn.from, conn.to].sort().join('-');
    if (!bundles[key]) bundles[key] = [];
    bundles[key].push(conn);
  });
  return bundles;
}

function getBundleOffset(index, total, gap = LINE_GAP) {
  if (total === 1) return 0;
  return (index - (total - 1) / 2) * gap;
}

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

// Calculate path length for SVG path
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

// Helper functions for data processing
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

async function getRealArtistDetails(mbid) {
  try {
    return await getArtistDetails(mbid);
  } catch (error) {
    console.error('Artist details error:', error);
    throw error;
  }
}

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

function getArtistYear(artist) {
  if (artist['life-span'] && artist['life-span'].begin) {
    return parseInt(artist['life-span'].begin.split('-')[0]);
  }
  return null;
}

function processRelationships(artistData) {
  const connections = [];
  
  if (!artistData.relations) return connections;
  
  artistData.relations.forEach(rel => {
    // Only process artist-to-artist relationships
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
    
    if (rel.type === 'performance' && rel.artist) {
      connections.push({
        type: 'tour',
        targetMbid: rel.artist.id,
        targetName: rel.artist.name,
        data: {
          event: 'Live Performance',
          date: rel.begin || 'Unknown',
          titles: rel.title ? [rel.title] : null
        }
      });
    }
  });
  
  return connections;
}

function autoLayoutStations(artists) {
  const positioned = {};
  const artistList = Object.values(artists);
  
  const byDecade = {};
  artistList.forEach(artist => {
    const year = artist.year || 1970;
    const decade = Math.floor(year / 10) * 10;
    if (!byDecade[decade]) byDecade[decade] = [];
    byDecade[decade].push(artist);
  });
  
  let y = 1;
  Object.keys(byDecade).sort().forEach(decade => {
    const artistsInDecade = byDecade[decade];
    artistsInDecade.forEach((artist, idx) => {
      positioned[artist.id] = {
        ...artist,
        x: (idx % 6) + 1,
        y: y + Math.floor(idx / 6)
      };
    });
    y += Math.ceil(artistsInDecade.length / 6) + 1;
  });
  
  return positioned;
}

const LINE_COLORS_LIGHT = {
  member: '#059669',
  studio: '#2563eb',
  tour: '#dc2626',
};

const LINE_COLORS_DARK = {
  member: '#10b981',
  studio: '#3b82f6',
  tour: '#ef4444',
};

const LINE_LABELS = {
  member: 'Personnel Line',
  studio: 'Studio Line',
  tour: 'Live Wire',
};

// Global offset for each line type to prevent crossing overlap
const LINE_TYPE_OFFSET = {
  member: 0,        // Green - center line
  studio: LINE_GAP, // Blue - offset to one side
  tour: -LINE_GAP,  // Red - offset to opposite side
};

const gridToPixel = (gridX, gridY) => ({
  x: gridX * GRID_SIZE,
  y: gridY * GRID_SIZE
});

// Find shortest path between two stations
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

export default function Counterpoint() {
  const [darkMode, setDarkMode] = useState(true);
  const [graph, setGraph] = useState({ artists: {}, connections: [] });
  const [selectedStation, setSelectedStation] = useState(null);
  const [hoveredStation, setHoveredStation] = useState(null);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [startStation, setStartStation] = useState(null);
  const [endStation, setEndStation] = useState(null);
  const [route, setRoute] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null);
  const [loadingArtists, setLoadingArtists] = useState(new Set());
  const [showSearch, setShowSearch] = useState(true);
  
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 800, height: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const LINE_COLORS = darkMode ? LINE_COLORS_DARK : LINE_COLORS_LIGHT;
  const backgroundColor = darkMode ? '#000000' : '#ffffff';
  const textColor = darkMode ? '#ffffff' : '#000000';
  const mutedText = darkMode ? '#9ca3af' : '#6b7280';
  const borderColor = darkMode ? '#333333' : '#e5e7eb';

  // Bundle connections for parallel line calculation
  const bundledConnections = useMemo(() => {
    return getBundledConnections(graph.connections);
  }, [graph.connections]);

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
      
      const hubPosition = calculateHubPosition(artistData);
      
      const newArtist = {
        id: mbid,
        name: artistData.name,
        type: artistData.type || 'artist',
        year: year,
        genre: genres,
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

  const exploreConnections = async (mbid) => {
    if (!graph.artists[mbid]) return;
    
    setLoadingArtists(prev => new Set(prev).add(mbid));
    setError(null);
    
    try {
      const artistData = await getRealArtistDetails(mbid);
      if (!artistData) return;
      
      const connections = processRelationships(artistData);
      
      const newArtists = {};
      const newConnections = [];
      
      for (const conn of connections) {
        if (!graph.artists[conn.targetMbid]) {
          try {
            const relatedData = await getRealArtistDetails(conn.targetMbid);
            if (!relatedData) continue;
            
            const year = getArtistYear(relatedData);
            const genres = extractGenres(relatedData);
            const hubPosition = calculateHubPosition(relatedData);
            
            newArtists[conn.targetMbid] = {
              id: conn.targetMbid,
              name: conn.targetName,
              type: relatedData.type || 'artist',
              year: year,
              genre: genres,
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
      
      const updatedArtists = {
        ...graph.artists,
        ...newArtists
      };
      
      const layouted = autoLayoutStations(updatedArtists);
      
      setGraph({
        artists: layouted,
        connections: [...graph.connections, ...newConnections]
      });
      
    } catch (err) {
      setError('Failed to explore connections. Please try again.');
      console.error(err);
    } finally {
      setLoadingArtists(prev => {
        const next = new Set(prev);
        next.delete(mbid);
        return next;
      });
    }
  };

  // Calculate route when start/end stations change
  useEffect(() => {
    if (startStation && endStation && startStation !== endStation) {
      const path = findAllPaths(graph, startStation, endStation);
      setRoute(path);
    } else {
      setRoute(null);
    }
  }, [startStation, endStation, graph]);

  const handleMouseDown = (e) => {
    if (e.button === 0) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
    }
  };

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

  const handleMouseUp = () => {
    setIsPanning(false);
  };

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

  // Check if connection is in route
  // Check if connection is in route
  const isConnectionInRoute = (conn) => {
    if (!route) return false;
    return route.some(step => 
      (step.conn.from === conn.from && step.conn.to === conn.to) ||
      (step.conn.from === conn.to && step.conn.to === conn.from)
    );
  };

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
              border: `2px solid ${LINE_COLORS.tour}`,
              borderRadius: '4px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: LINE_COLORS.tour
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
          <h3 style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '12px' }}>
            ON MAP ({Object.keys(graph.artists).length})
          </h3>
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
            {Object.values(graph.artists).map(artist => (
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
                background: LINE_COLORS.tour,
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
            border: `2px solid ${LINE_COLORS.tour}`,
            borderRadius: '4px',
            padding: '12px',
            fontSize: '11px',
            maxWidth: '280px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <AlertCircle size={16} style={{ color: LINE_COLORS.tour }} />
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
                background: LINE_COLORS.tour,
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
              <g key={idx}>
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
                    transition: 'all 0.2s ease',
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
              <g key={artist.id}>
                {/* White outline */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={STATION_RADIUS + 3}
                  fill={backgroundColor}
                  stroke="none"
                />
                {/* Main station circle */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={STATION_RADIUS}
                  fill={isStart ? LINE_COLORS.member : (isEnd ? LINE_COLORS.tour : (isSelected ? '#ffffff' : backgroundColor))}
                  stroke={isStart ? LINE_COLORS.member : (isEnd ? LINE_COLORS.tour : (isSelected ? '#ffffff' : (isInRoute ? '#ffffff' : borderColor)))}
                  strokeWidth={isInRoute || isStart || isEnd ? 5 : 4}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedStation(selectedStation?.id === artist.id ? null : artist);
                  }}
                  onDoubleClick={() => exploreConnections(artist.id)}
                  onMouseEnter={() => setHoveredStation(artist)}
                  onMouseLeave={() => setHoveredStation(null)}
                  style={{ cursor: 'pointer' }}
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
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
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
            width: '300px',
            background: darkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)',
            border: `2px solid ${borderColor}`,
            borderRadius: '4px',
            padding: '16px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div>
                <h3 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {selectedStation.name}
                </h3>
                <div style={{ fontSize: '11px', color: mutedText }}>
                  {selectedStation.type} • {selectedStation.genre} • {selectedStation.year}
                </div>
              </div>
              <button onClick={() => setSelectedStation(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: mutedText }}>
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
                  background: endStation === selectedStation.id ? LINE_COLORS.tour : (darkMode ? '#1a1a1a' : '#ffffff'),
                  color: endStation === selectedStation.id ? '#ffffff' : textColor,
                  border: `2px solid ${endStation === selectedStation.id ? LINE_COLORS.tour : borderColor}`,
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
