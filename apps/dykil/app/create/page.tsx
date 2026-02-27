'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type FieldType = 'text' | 'textarea' | 'select' | 'rating' | 'boolean' | 'number';

interface FieldDefinition {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

interface Survey {
  id?: string;
  title: string;
  description: string;
  fields: FieldDefinition[];
  status: 'draft' | 'published' | 'closed';
}

export default function CreateSurveyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('id');

  const [loading, setLoading] = useState(!!editId);
  const [saving, setSaving] = useState(false);

  const [survey, setSurvey] = useState<Survey>({
    title: '',
    description: '',
    fields: [],
    status: 'draft',
  });

  const [showFieldForm, setShowFieldForm] = useState(false);
  const [editingFieldIndex, setEditingFieldIndex] = useState<number | null>(null);
  const [fieldForm, setFieldForm] = useState<FieldDefinition>({
    id: '',
    type: 'text',
    label: '',
    required: false,
  });

  useEffect(() => {
    if (editId) {
      fetchSurvey();
    }
  }, [editId]);

  const fetchSurvey = async () => {
    try {
      const res = await fetch(`/api/surveys/${editId}`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setSurvey(data);
      } else {
        alert('Failed to load survey');
        router.push('/dashboard');
      }
    } catch (error) {
      console.error('Failed to fetch survey:', error);
      alert('Failed to load survey');
    } finally {
      setLoading(false);
    }
  };

  const generateFieldId = () => {
    return `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  };

  const openFieldForm = (type: FieldType) => {
    setFieldForm({
      id: generateFieldId(),
      type,
      label: '',
      required: false,
      ...(type === 'select' && { options: [''] }),
      ...(type === 'rating' && { min: 1, max: 5 }),
      ...(type === 'number' && { min: undefined, max: undefined }),
    });
    setEditingFieldIndex(null);
    setShowFieldForm(true);
  };

  const editField = (index: number) => {
    setFieldForm({ ...survey.fields[index] });
    setEditingFieldIndex(index);
    setShowFieldForm(true);
  };

  const saveField = () => {
    if (!fieldForm.label.trim()) {
      alert('Field label is required');
      return;
    }

    if (fieldForm.type === 'select' && (!fieldForm.options || fieldForm.options.filter(o => o.trim()).length === 0)) {
      alert('Select fields must have at least one option');
      return;
    }

    const newFields = [...survey.fields];
    if (editingFieldIndex !== null) {
      newFields[editingFieldIndex] = fieldForm;
    } else {
      newFields.push(fieldForm);
    }

    setSurvey({ ...survey, fields: newFields });
    setShowFieldForm(false);
    setFieldForm({
      id: '',
      type: 'text',
      label: '',
      required: false,
    });
  };

  const deleteField = (index: number) => {
    if (!confirm('Delete this field?')) return;
    const newFields = survey.fields.filter((_, i) => i !== index);
    setSurvey({ ...survey, fields: newFields });
  };

  const moveField = (index: number, direction: 'up' | 'down') => {
    const newFields = [...survey.fields];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    if (targetIndex < 0 || targetIndex >= newFields.length) return;

    [newFields[index], newFields[targetIndex]] = [newFields[targetIndex], newFields[index]];
    setSurvey({ ...survey, fields: newFields });
  };

  const saveSurvey = async (publish: boolean = false) => {
    if (!survey.title.trim()) {
      alert('Survey title is required');
      return;
    }

    if (survey.fields.length === 0) {
      alert('Survey must have at least one field');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...survey,
        status: publish ? 'published' : survey.status,
      };

      const res = await fetch(
        editId ? `/api/surveys/${editId}` : '/api/surveys',
        {
          method: editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        }
      );

      if (res.ok) {
        router.push('/dashboard');
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to save survey');
      }
    } catch (error) {
      console.error('Failed to save survey:', error);
      alert('Failed to save survey');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">
            {editId ? 'Edit Survey' : 'Create Survey'}
          </h1>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            Cancel
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Builder Panel */}
          <div className="space-y-6">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4">Survey Details</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Title *</label>
                  <input
                    type="text"
                    value={survey.title}
                    onChange={(e) => setSurvey({ ...survey, title: e.target.value })}
                    placeholder="Survey title"
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea
                    value={survey.description}
                    onChange={(e) => setSurvey({ ...survey, description: e.target.value })}
                    placeholder="Optional description"
                    rows={3}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Fields ({survey.fields.length})</h2>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  onClick={() => openFieldForm('text')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Text
                </button>
                <button
                  onClick={() => openFieldForm('textarea')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Textarea
                </button>
                <button
                  onClick={() => openFieldForm('select')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Select
                </button>
                <button
                  onClick={() => openFieldForm('rating')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Rating
                </button>
                <button
                  onClick={() => openFieldForm('boolean')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Yes/No
                </button>
                <button
                  onClick={() => openFieldForm('number')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Number
                </button>
              </div>

              {showFieldForm && (
                <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-300 dark:border-gray-700">
                  <h3 className="text-lg font-semibold mb-3">
                    {editingFieldIndex !== null ? 'Edit Field' : `Add ${fieldForm.type} Field`}
                  </h3>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Label *</label>
                      <input
                        type="text"
                        value={fieldForm.label}
                        onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
                        placeholder="Field label"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={fieldForm.required || false}
                        onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })}
                        id="required"
                        className="rounded"
                      />
                      <label htmlFor="required" className="text-sm">Required field</label>
                    </div>

                    {fieldForm.type === 'select' && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Options</label>
                        {(fieldForm.options || ['']).map((option, i) => (
                          <div key={i} className="flex gap-2 mb-2">
                            <input
                              type="text"
                              value={option}
                              onChange={(e) => {
                                const newOptions = [...(fieldForm.options || [])];
                                newOptions[i] = e.target.value;
                                setFieldForm({ ...fieldForm, options: newOptions });
                              }}
                              placeholder={`Option ${i + 1}`}
                              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                            />
                            {i > 0 && (
                              <button
                                onClick={() => {
                                  const newOptions = (fieldForm.options || []).filter((_, idx) => idx !== i);
                                  setFieldForm({ ...fieldForm, options: newOptions });
                                }}
                                className="px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          onClick={() => {
                            setFieldForm({ ...fieldForm, options: [...(fieldForm.options || []), ''] });
                          }}
                          className="text-sm text-orange-500 hover:text-orange-600"
                        >
                          + Add option
                        </button>
                      </div>
                    )}

                    {(fieldForm.type === 'rating' || fieldForm.type === 'number') && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Min</label>
                          <input
                            type="number"
                            value={fieldForm.min || ''}
                            onChange={(e) => setFieldForm({ ...fieldForm, min: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Max</label>
                          <input
                            type="number"
                            value={fieldForm.max || ''}
                            onChange={(e) => setFieldForm({ ...fieldForm, max: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={saveField}
                        className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                      >
                        {editingFieldIndex !== null ? 'Save Changes' : 'Add Field'}
                      </button>
                      <button
                        onClick={() => {
                          setShowFieldForm(false);
                          setEditingFieldIndex(null);
                        }}
                        className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {survey.fields.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No fields yet. Add a field using the buttons above.
                  </div>
                ) : (
                  survey.fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="p-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 flex items-center justify-between"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-sm">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </div>
                        <div className="text-xs text-gray-500">
                          {field.type}
                          {field.type === 'select' && ` (${(field.options || []).length} options)`}
                          {field.type === 'rating' && ` (${field.min || 1}-${field.max || 5})`}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => moveField(index, 'up')}
                          disabled={index === 0}
                          className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded text-xs disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => moveField(index, 'down')}
                          disabled={index === survey.fields.length - 1}
                          className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded text-xs disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => editField(index)}
                          className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteField(index)}
                          className="px-2 py-1 border border-red-300 dark:border-red-700 text-red-600 rounded text-xs hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => saveSurvey(false)}
                disabled={saving}
                className="flex-1 px-6 py-3 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save as Draft'}
              </button>
              <button
                onClick={() => saveSurvey(true)}
                disabled={saving}
                className="flex-1 px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition disabled:opacity-50"
              >
                {saving ? 'Publishing...' : 'Publish Survey'}
              </button>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="lg:sticky lg:top-6 h-fit">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4">Live Preview</h2>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <h3 className="text-2xl font-bold mb-2">
                  {survey.title || 'Untitled Survey'}
                </h3>
                {survey.description && (
                  <p className="text-gray-600 dark:text-gray-400 mb-6">
                    {survey.description}
                  </p>
                )}

                {survey.fields.length === 0 ? (
                  <div className="text-center py-12 text-gray-500 text-sm">
                    Preview will appear here as you add fields
                  </div>
                ) : (
                  <div className="space-y-6">
                    {survey.fields.map((field) => (
                      <div key={field.id}>
                        <label className="block text-sm font-medium mb-2">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </label>

                        {field.type === 'text' && (
                          <input
                            type="text"
                            placeholder="Text input"
                            disabled
                            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900"
                          />
                        )}

                        {field.type === 'textarea' && (
                          <textarea
                            placeholder="Textarea input"
                            rows={3}
                            disabled
                            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900"
                          />
                        )}

                        {field.type === 'select' && (
                          <select
                            disabled
                            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900"
                          >
                            <option>Select an option</option>
                            {(field.options || []).map((option, i) => (
                              <option key={i}>{option || `Option ${i + 1}`}</option>
                            ))}
                          </select>
                        )}

                        {field.type === 'rating' && (
                          <div className="flex gap-2">
                            {Array.from({ length: (field.max || 5) - (field.min || 1) + 1 }, (_, i) => (
                              <button
                                key={i}
                                disabled
                                className="w-10 h-10 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900"
                              >
                                {(field.min || 1) + i}
                              </button>
                            ))}
                          </div>
                        )}

                        {field.type === 'boolean' && (
                          <div className="flex gap-4">
                            <label className="flex items-center gap-2">
                              <input type="radio" disabled name={field.id} />
                              <span>Yes</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="radio" disabled name={field.id} />
                              <span>No</span>
                            </label>
                          </div>
                        )}

                        {field.type === 'number' && (
                          <input
                            type="number"
                            placeholder={`Number${field.min !== undefined || field.max !== undefined ? ` (${field.min || ''}${field.min !== undefined && field.max !== undefined ? '-' : ''}${field.max || ''})` : ''}`}
                            disabled
                            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900"
                          />
                        )}
                      </div>
                    ))}

                    <button
                      disabled
                      className="w-full px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold opacity-50"
                    >
                      Submit
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
