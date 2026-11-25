# Saved county GIS pages (synthetic)

Pages shaped like a county's own GIS / assessor page, as Keelix reads them before it asks a county's
hosted (ArcGIS Online) parcel map (backend/src/parcelServiceLink.ts). Every county, host, organisation
id and service name here is invented. Used by backend/test/parcelServiceLink.test.ts; no network.

- `links-service.html` — links the parcel feature service itself (a REST link in a data table).
- `links-org-site.html` — links only the county's map app on its organisation site
  (`<name>.maps.arcgis.com`), plus an embedded map in an iframe.
- `links-other-org.html` — links a service of a DIFFERENT organisation on the same platform host.
- `link-only-in-script.html` — the service URL appears only inside a script, a comment and a style
  block (none of which is the county's published word).
- `no-link.html` — a GIS page with no hosted-map link at all.
