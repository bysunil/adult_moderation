import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const parentDir = path.resolve(process.cwd(), '..');
    const timelinePath = path.join(parentDir, 'timeline.json');

    if (fs.existsSync(timelinePath)) {
      const data = fs.readFileSync(timelinePath, 'utf8');
      return NextResponse.json(JSON.parse(data));
    }

    return NextResponse.json({ categories: {}, unified_scenes: [] });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
