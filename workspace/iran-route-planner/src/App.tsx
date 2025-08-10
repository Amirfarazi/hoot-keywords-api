import { useCallback, useMemo, useRef, useState } from 'react'
import './App.css'
import { GoogleMap, Marker, DirectionsRenderer, Autocomplete, useJsApiLoader } from '@react-google-maps/api'

const DEFAULT_CENTER = { lat: 35.715, lng: 51.404 } // Tehran

function App() {
  const [origin, setOrigin] = useState<google.maps.LatLngLiteral | null>(null)
  const [destination, setDestination] = useState<google.maps.LatLngLiteral | null>(null)
  const [waypoints, setWaypoints] = useState<Array<google.maps.DirectionsWaypoint>>([])
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null)
  const [loadingRoute, setLoadingRoute] = useState(false)

  const originInputRef = useRef<HTMLInputElement | null>(null)
  const destinationInputRef = useRef<HTMLInputElement | null>(null)
  const waypointInputRef = useRef<HTMLInputElement | null>(null)


  const { isLoaded, loadError } = useJsApiLoader({
    id: 'iran-route-planner-map',
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string,
    libraries: ['places'],
    language: 'fa',
    region: 'IR',
    version: 'weekly'
  })

  const mapContainerStyle = useMemo(() => ({ width: '100%', height: '100%' }), [])

  const handlePlaceToLatLng = (place: google.maps.places.PlaceResult) => {
    if (place.geometry?.location) {
      const loc = place.geometry.location
      return { lat: loc.lat(), lng: loc.lng() }
    }
    return null
  }

  const onSelectOrigin = (place: google.maps.places.PlaceResult) => {
    const loc = handlePlaceToLatLng(place)
    if (loc) setOrigin(loc)
  }

  const onSelectDestination = (place: google.maps.places.PlaceResult) => {
    const loc = handlePlaceToLatLng(place)
    if (loc) setDestination(loc)
  }

  const onAddWaypoint = (place: google.maps.places.PlaceResult) => {
    const loc = handlePlaceToLatLng(place)
    if (loc) {
      setWaypoints(prev => [...prev, { location: loc, stopover: true }])
      if (waypointInputRef.current) waypointInputRef.current.value = ''
    }
  }

  const computeRoute = useCallback(async () => {
    if (!origin || !destination || !isLoaded) return
    setLoadingRoute(true)
    setDirections(null)
    try {
      const service = new google.maps.DirectionsService()
      const result = await service.route({
        origin,
        destination,
        waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
        optimizeWaypoints: true,
        drivingOptions: {
          departureTime: new Date(),
          trafficModel: google.maps.TrafficModel.BEST_GUESS,
        },
        region: 'IR',
      })
      setDirections(result)
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingRoute(false)
    }
  }, [origin, destination, waypoints, isLoaded])

  const clearRoute = () => {
    setDirections(null)
    setWaypoints([])
  }

  if (loadError) {
    return <div className="p-6 text-red-600">خطا در بارگذاری نقشه</div>
  }

  return (
    <div className="flex h-dvh">
      {/* Sidebar */}
      <div className="w-full md:w-96 border-l border-slate-200 bg-white p-4 overflow-y-auto">
        <h1 className="text-xl font-bold text-slate-800 mb-4">مسیریاب بهینه ایران</h1>

        <div className="space-y-3">
          <div>
            <label className="block mb-1 text-sm text-slate-600">مبدا</label>
            {isLoaded && (
              <Autocomplete onPlaceChanged={() => onSelectOrigin((window as any).originAutocomplete.getPlace())} onLoad={(ac) => ((window as any).originAutocomplete = ac)}>
                <input ref={originInputRef} className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="مثلاً تهران، آزادی" />
              </Autocomplete>
            )}
          </div>

          <div>
            <label className="block mb-1 text-sm text-slate-600">مقصد</label>
            {isLoaded && (
              <Autocomplete onPlaceChanged={() => onSelectDestination((window as any).destinationAutocomplete.getPlace())} onLoad={(ac) => ((window as any).destinationAutocomplete = ac)}>
                <input ref={destinationInputRef} className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="مثلاً اصفهان، نقش جهان" />
              </Autocomplete>
            )}
          </div>

          <div>
            <label className="block mb-1 text-sm text-slate-600">نقطه میانی (اختیاری)</label>
            {isLoaded && (
              <Autocomplete onPlaceChanged={() => onAddWaypoint((window as any).waypointAutocomplete.getPlace())} onLoad={(ac) => ((window as any).waypointAutocomplete = ac)}>
                <input ref={waypointInputRef} className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="مثلاً قم" />
              </Autocomplete>
            )}
            {waypoints.length > 0 && (
              <div className="mt-2 text-xs text-slate-600">{waypoints.length} نقطه اضافه شد</div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={computeRoute} disabled={!origin || !destination || loadingRoute} className="inline-flex items-center justify-center rounded-lg bg-sky-600 text-white px-4 py-2 disabled:opacity-50 hover:bg-sky-700 transition">
              {loadingRoute ? 'در حال محاسبه…' : 'محاسبه مسیر'}
            </button>
            <button onClick={clearRoute} className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50">بازنشانی</button>
          </div>

          {directions && (
            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium text-slate-700">مسافت و زمان تقریبی</div>
              <ul className="space-y-1 text-sm text-slate-700">
                {directions.routes[0].legs.map((leg, idx) => (
                  <li key={idx} className="flex justify-between bg-slate-50 border border-slate-200 rounded-lg p-2">
                    <span>بخش {idx + 1}</span>
                    <span>{leg.distance?.text} • {leg.duration_in_traffic?.text || leg.duration?.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <p className="mt-6 text-xs text-slate-500">برای بهترین نتایج، ترافیک زنده و بهینه‌سازی نقاط میانی فعال است.</p>
      </div>

      {/* Map */}
      <div className="flex-1">
        {isLoaded ? (
          <GoogleMap
            mapContainerStyle={mapContainerStyle}
            center={origin || DEFAULT_CENTER}
            zoom={origin ? 9 : 10}
            options={{
              mapTypeControl: false,
              fullscreenControl: true,
              streetViewControl: false,
              gestureHandling: 'greedy',
              restriction: { latLngBounds: { north: 41.0, south: 24.0, west: 44.0, east: 64.0 }, strictBounds: false },
              clickableIcons: true,
              styles: [
                { elementType: 'geometry', stylers: [{ color: '#ebe3cd' }] },
                { elementType: 'labels.text.fill', stylers: [{ color: '#523735' }] },
                { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f1e6' }] },
              ],
            }}
          >
            {!directions && origin && <Marker position={origin} />}
            {!directions && destination && <Marker position={destination} />}
            {directions && (
              <DirectionsRenderer
                directions={directions}
                options={{ suppressMarkers: false, preserveViewport: false }}
              />
            )}
          </GoogleMap>
        ) : (
          <div className="h-full flex items-center justify-center">در حال بارگذاری نقشه…</div>
        )}
      </div>
    </div>
  )
}

export default App
