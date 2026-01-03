# Counterpoint

A transit-style music history map that visualizes connections between artists.

![React](https://img.shields.io/badge/React-18-blue)
![MusicBrainz](https://img.shields.io/badge/API-MusicBrainz-orange)
![Wikidata](https://img.shields.io/badge/API-Wikidata-green)

## Overview

Counterpoint displays music history as an interactive subway-style map. Artists appear as stations, and colored lines represent different types of professional relationships between them.

## Features

- **Artist Search** - Search and add artists from the MusicBrainz database
- **Connection Visualization** - See relationships as color-coded metro lines
- **Route Finding** - Find the path between any two artists
- **Artist Photos** - Automatically fetched from Wikidata
- **Dark/Light Mode** - Toggle between themes

## Connection Types

| Line | Color | Meaning |
|------|-------|---------|
| Personnel Line | Green | Band membership |
| Studio Line | Blue | Collaborations & production |
| Writing Credits | Purple | Co-written songs |
| Record Label | Yellow | Shared record labels |

## Getting Started

### Prerequisites

- Node.js 16+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/stephankcost/aywob.git
cd aywob

# Install dependencies
npm install

# Start the development server
npm start
```

The app will open at `http://localhost:3000`

## Usage

1. **Search** for an artist in the left panel (try: Beatles, Yardbirds, Dylan)
2. **Click** a search result to add them to the map
3. **Select** a station to see artist details
4. **Double-click** or click "Explore Connections" to discover related artists
5. **Set Start/End** points to find routes between artists
6. **Click** connection lines to see relationship details

### Controls

- **Pan** - Click and drag the map
- **Zoom** - Mouse wheel
- **Select** - Click a station
- **Explore** - Double-click a station

## Tech Stack

- **React** - UI framework
- **MusicBrainz API** - Artist data and relationships
- **Wikidata API** - Artist images
- **Lucide React** - Icons
- **SVG** - Map rendering with octilinear paths

## Project Structure

```
src/
├── App.jsx          # Main application (organized into sections)
│   ├── Constants    # Grid sizes, colors, labels
│   ├── API          # MusicBrainz & Wikidata fetching
│   ├── Geometry     # SVG path generation
│   ├── Data         # Relationship processing
│   ├── Layout       # Auto-positioning algorithm
│   └── Component    # React state, handlers, render
└── index.js         # Entry point
```

## API Rate Limiting

MusicBrainz requires a 1 request/second rate limit. The app handles this automatically.

## License

MIT

## Acknowledgments

- [MusicBrainz](https://musicbrainz.org/) for the comprehensive music database
- [Wikidata](https://www.wikidata.org/) for artist images
- Inspired by transit maps worldwide
