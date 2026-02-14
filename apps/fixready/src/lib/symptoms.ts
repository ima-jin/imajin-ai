import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface SymptomClarifier {
  id: string;
  question: string;
  type: 'text' | 'textarea' | 'select';
  options?: string[];
  optional?: boolean;
}

export interface SuggestedPart {
  name: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface Symptom {
  id: string;
  label: string;
  clarifiers: SymptomClarifier[];
  suggested_causes: string[];
  suggested_parts: SuggestedPart[];
}

export interface SymptomTree {
  appliance_type: string;
  symptoms: Symptom[];
}

const symptomCache = new Map<string, SymptomTree>();

export function getSymptoms(applianceType: string): SymptomTree | null {
  // Check cache first
  if (symptomCache.has(applianceType)) {
    return symptomCache.get(applianceType)!;
  }

  try {
    const filePath = path.join(process.cwd(), 'data', 'symptoms', `${applianceType}.yaml`);

    if (!fs.existsSync(filePath)) {
      console.warn(`No symptom file found for appliance type: ${applianceType}`);
      return null;
    }

    const fileContents = fs.readFileSync(filePath, 'utf8');
    const data = yaml.load(fileContents) as SymptomTree;

    // Cache the result
    symptomCache.set(applianceType, data);

    return data;
  } catch (error) {
    console.error(`Error loading symptom file for ${applianceType}:`, error);
    return null;
  }
}

export function getSymptomById(applianceType: string, symptomId: string): Symptom | null {
  const tree = getSymptoms(applianceType);
  if (!tree) return null;

  return tree.symptoms.find(s => s.id === symptomId) || null;
}

export function getAllApplianceTypes(): string[] {
  try {
    const symptomsDir = path.join(process.cwd(), 'data', 'symptoms');
    const files = fs.readdirSync(symptomsDir);
    return files
      .filter(f => f.endsWith('.yaml'))
      .map(f => f.replace('.yaml', ''));
  } catch (error) {
    console.error('Error reading symptoms directory:', error);
    return [];
  }
}
