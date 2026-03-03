'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import 'survey-core/survey-core.min.css';
import type { SurveyJSElement, SurveyJSElementType } from '@/db/schema';

interface SurveyData {
  id?: string;
  title: string;
  description: string;
  fields: { elements: SurveyJSElement[] };
  status: 'draft' | 'published' | 'closed';
  type?: string;
}

function CreateSurveyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('id');

  const [loading, setLoading] = useState(!!editId);
  const [saving, setSaving] = useState(false);

  const [survey, setSurvey] = useState<SurveyData>({
    title: '',
    description: '',
    fields: { elements: [] },
    status: 'draft',
    type: 'survey',
  });

  const [showFieldForm, setShowFieldForm] = useState(false);
  const [editingFieldIndex, setEditingFieldIndex] = useState<number | null>(null);
  const [fieldForm, setFieldForm] = useState<SurveyJSElement>({
    type: 'text',
    name: '',
    title: '',
    isRequired: false,
  });

  useEffect(() => {
    if (editId) {
      fetchSurvey();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const fetchSurvey = async () => {
    try {
      const res = await fetch(`/api/surveys/${editId}`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setSurvey({
          ...data,
          fields: typeof data.fields === 'object' && 'elements' in data.fields || 'pages' in data.fields
            ? data.fields
            : { elements: Array.isArray(data.fields) ? data.fields : [] }
        });
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

  const generateFieldName = () => {
    return `q${Date.now()}`;
  };

  const openFieldForm = (type: SurveyJSElementType) => {
    const newField: SurveyJSElement = {
      type,
      name: generateFieldName(),
      title: '',
      isRequired: false,
    };

    // Add type-specific defaults
    if (type === 'radiogroup' || type === 'checkbox' || type === 'dropdown') {
      newField.choices = ['Option 1'];
    } else if (type === 'rating') {
      newField.rateMin = 1;
      newField.rateMax = 5;
    } else if (type === 'text') {
      // Default to text input
    }

    setFieldForm(newField);
    setEditingFieldIndex(null);
    setShowFieldForm(true);
  };

  const editField = (index: number) => {
    setFieldForm({ ...survey.fields.elements[index] });
    setEditingFieldIndex(index);
    setShowFieldForm(true);
  };

  const saveField = () => {
    if (!fieldForm.title.trim()) {
      alert('Question title is required');
      return;
    }

    if ((fieldForm.type === 'radiogroup' || fieldForm.type === 'checkbox' || fieldForm.type === 'dropdown') &&
        (!fieldForm.choices || fieldForm.choices.length === 0 || !fieldForm.choices.some(c => typeof c === 'string' ? c.trim() : c.text?.trim()))) {
      alert('Multiple choice questions must have at least one option');
      return;
    }

    const newElements = [...survey.fields.elements];
    if (editingFieldIndex !== null) {
      newElements[editingFieldIndex] = fieldForm;
    } else {
      newElements.push(fieldForm);
    }

    setSurvey({ ...survey, fields: { elements: newElements } });
    setShowFieldForm(false);
    setFieldForm({
      type: 'text',
      name: '',
      title: '',
      isRequired: false,
    });
  };

  const deleteField = (index: number) => {
    if (!confirm('Delete this question?')) return;
    const newElements = survey.fields.elements.filter((_, i) => i !== index);
    setSurvey({ ...survey, fields: { elements: newElements } });
  };

  const moveField = (index: number, direction: 'up' | 'down') => {
    const newElements = [...survey.fields.elements];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    if (targetIndex < 0 || targetIndex >= newElements.length) return;

    [newElements[index], newElements[targetIndex]] = [newElements[targetIndex], newElements[index]];
    setSurvey({ ...survey, fields: { elements: newElements } });
  };

  const saveSurvey = async (publish: boolean = false) => {
    if (!survey.title.trim()) {
      alert('Survey title is required');
      return;
    }

    if (survey.fields.elements.length === 0) {
      alert('Survey must have at least one question');
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

  // Create SurveyJS model for preview
  const previewModel = survey.fields.elements.length > 0
    ? new Model({
        elements: survey.fields.elements,
        showQuestionNumbers: 'off',
      })
    : null;

  // Apply orange theme
  if (previewModel) {
    previewModel.applyTheme({
      cssVariables: {
        '--sjs-primary-backcolor': '#f97316',
        '--sjs-primary-backcolor-dark': '#ea580c',
        '--sjs-primary-backcolor-light': '#fb923c',
      }
    });
  }

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
                <h2 className="text-xl font-semibold">Questions ({survey.fields.elements.length})</h2>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  onClick={() => openFieldForm('text')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Text
                </button>
                <button
                  onClick={() => openFieldForm('comment')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Comment
                </button>
                <button
                  onClick={() => openFieldForm('radiogroup')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Radio
                </button>
                <button
                  onClick={() => openFieldForm('checkbox')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Checkbox
                </button>
                <button
                  onClick={() => openFieldForm('dropdown')}
                  className="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                >
                  + Dropdown
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
              </div>

              {showFieldForm && (
                <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-300 dark:border-gray-700">
                  <h3 className="text-lg font-semibold mb-3">
                    {editingFieldIndex !== null ? 'Edit Question' : `Add ${fieldForm.type} Question`}
                  </h3>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Question Text *</label>
                      <input
                        type="text"
                        value={fieldForm.title}
                        onChange={(e) => setFieldForm({ ...fieldForm, title: e.target.value })}
                        placeholder="What would you like to ask?"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={fieldForm.isRequired || false}
                        onChange={(e) => setFieldForm({ ...fieldForm, isRequired: e.target.checked })}
                        id="required"
                        className="rounded"
                      />
                      <label htmlFor="required" className="text-sm">Required question</label>
                    </div>

                    {(fieldForm.type === 'radiogroup' || fieldForm.type === 'checkbox' || fieldForm.type === 'dropdown') && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Answer Choices</label>
                        {(fieldForm.choices || []).map((choice, i) => {
                          const choiceText = typeof choice === 'string' ? choice : choice.text || '';
                          return (
                            <div key={i} className="flex gap-2 mb-2">
                              <input
                                type="text"
                                value={choiceText}
                                onChange={(e) => {
                                  const newChoices = [...(fieldForm.choices || [])];
                                  newChoices[i] = e.target.value;
                                  setFieldForm({ ...fieldForm, choices: newChoices });
                                }}
                                placeholder={`Choice ${i + 1}`}
                                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                              />
                              {i > 0 && (
                                <button
                                  onClick={() => {
                                    const newChoices = (fieldForm.choices || []).filter((_, idx) => idx !== i);
                                    setFieldForm({ ...fieldForm, choices: newChoices });
                                  }}
                                  className="px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          );
                        })}
                        <button
                          onClick={() => {
                            setFieldForm({ ...fieldForm, choices: [...(fieldForm.choices || []), ''] });
                          }}
                          className="text-sm text-orange-500 hover:text-orange-600"
                        >
                          + Add choice
                        </button>
                      </div>
                    )}

                    {fieldForm.type === 'rating' && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Min Value</label>
                          <input
                            type="number"
                            value={fieldForm.rateMin || 1}
                            onChange={(e) => setFieldForm({ ...fieldForm, rateMin: Number(e.target.value) })}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Max Value</label>
                          <input
                            type="number"
                            value={fieldForm.rateMax || 5}
                            onChange={(e) => setFieldForm({ ...fieldForm, rateMax: Number(e.target.value) })}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                          />
                        </div>
                      </div>
                    )}

                    {fieldForm.type === 'text' && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Input Type</label>
                        <select
                          value={fieldForm.inputType || 'text'}
                          onChange={(e) => setFieldForm({ ...fieldForm, inputType: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                        >
                          <option value="text">Text</option>
                          <option value="email">Email</option>
                          <option value="number">Number</option>
                        </select>
                      </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={saveField}
                        className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 transition"
                      >
                        {editingFieldIndex !== null ? 'Save Changes' : 'Add Question'}
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
                {survey.fields.elements.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No questions yet. Add a question using the buttons above.
                  </div>
                ) : (
                  survey.fields.elements.map((field, index) => (
                    <div
                      key={field.name}
                      className="p-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 flex items-center justify-between"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-sm">
                          {field.title}
                          {field.isRequired && <span className="text-red-500 ml-1">*</span>}
                        </div>
                        <div className="text-xs text-gray-500">
                          {field.type}
                          {(field.type === 'radiogroup' || field.type === 'checkbox' || field.type === 'dropdown') &&
                            ` (${field.choices?.length || 0} choices)`}
                          {field.type === 'rating' && ` (${field.rateMin || 1}-${field.rateMax || 5})`}
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
                          disabled={index === survey.fields.elements.length - 1}
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

                {survey.fields.elements.length === 0 ? (
                  <div className="text-center py-12 text-gray-500 text-sm">
                    Preview will appear here as you add questions
                  </div>
                ) : previewModel ? (
                  <Survey model={previewModel} />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CreateSurveyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-orange-500" /></div>}>
      <CreateSurveyContent />
    </Suspense>
  );
}
