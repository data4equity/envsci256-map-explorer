# ENVSCI 256 Course Map Explorer

A web map for ENVSCI 256, Health and Medical Geography, at the University of Massachusetts Boston.
Students filter Massachusetts census tracts by town, color them by a health or population
measure, add a road or open-space layer, buffer it, and save a map image or a link that reopens
the map.

**Open it:** https://data4equity.github.io/envsci256-map-explorer/

## Data

- CDC PLACES: Census Tract Data (GIS Friendly Format), 2025 release, data.cdc.gov (public domain)
- U.S. Census Bureau, American Community Survey 2019–2023 5-year, Tables B01001 and B11005; TIGER/Line 2023 tracts
- MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS: MassGIS-MassDOT Roads
  and Protected and Recreational OpenSpace (public record)

Basemap tiles: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community.

## Libraries

Leaflet 1.9.4, Turf 7.1.0 and simple-statistics 7.8.3, in `vendor/` with their licenses.
