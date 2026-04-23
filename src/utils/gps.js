// ============================================================
// GPS Utility - Haversine Distance
// ============================================================

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // รัศมีโลก (เมตร)
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function isWithinRadius(studentLat, studentLng, classroomLat, classroomLng, radiusM) {
  const distance = haversineDistance(studentLat, studentLng, classroomLat, classroomLng);
  return {
    distance: Math.round(distance * 100) / 100,
    withinRadius: distance <= radiusM
  };
}

module.exports = { haversineDistance, isWithinRadius };
