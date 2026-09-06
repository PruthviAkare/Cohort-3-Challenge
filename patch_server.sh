sed -i 's/moodLabel?: string;/moodLabel?: string;\n  location?: { lat: number; lng: number; address: string; name?: string };/' server.ts
