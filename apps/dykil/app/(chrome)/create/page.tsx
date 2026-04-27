'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@imajin/config';
import { useToast } from '@imajin/ui';
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

function FieldFormPanel({
  fieldForm,
  setFieldForm,
  onSave,
  onCancel,
  isEditing,
}: {
  fieldForm: SurveyJSElement;
  setFieldForm: (f: SurveyJSElement) => void;
  onSave: () => void;
  onCancel: () => void;
  isEditing: boolean;
}) {
  return (
    <div className="mb-2 p-4 bg-surface-elevated border-2 border-imajin-purple/50">
      <h3 className="text-lg font-semibold mb-3">
        {isEditing ? 'Edit Question' : `Add ${fieldForm.type} Question`}
      </h3>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Question Text *</label>
          <input
            type="text"
            value={fieldForm.title}
            onChange={(e) => setFieldForm({ ...fieldForm, title: e.target.value })}
            placeholder="What would you like to ask?"
            className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated text-sm"
            autoFocus
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={fieldForm.isRequired || false}
            onChange={(e) => setFieldForm({ ...fieldForm, isRequired: e.target.checked })}
            id={`required-${isEditing ? 'edit' : 'new'}`}
            className=""
          />
          <label htmlFor={`required-${isEditing ? 'edit' : 'new'}`} className="text-sm">Required question</label>
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
                    className="flex-1 px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated text-sm"
                  />
                  {i > 0 && (
                    <button
                      onClick={() => {
                        const newChoices = (fieldForm.choices || []).filter((_, idx) => idx !== i);
                        setFieldForm({ ...fieldForm, choices: newChoices });
                      }}
                      className="px-2 py-1 text-error:bg-error/10 dark:hover:bg-red-900/20"
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
              className="text-sm text-imajin-orange:text-imajin-orange"
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
                className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Max Value</label>
              <input
                type="number"
                value={fieldForm.rateMax || 5}
                onChange={(e) => setFieldForm({ ...fieldForm, rateMax: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated text-sm"
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
              className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated text-sm"
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="number">Number</option>
            </select>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={onSave}
            className="px-4 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
          >
            {isEditing ? 'Save Changes' : 'Add Question'}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 border border-white/10 dark:border-white/10 text-sm:bg-surface-elevated dark:hover:bg-surface-elevated transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateSurveyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
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
      const res = await apiFetch(`/api/surveys/${editId}`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        // Flatten multi-page surveys into elements for the editor
        let elements: SurveyJSElement[] = [];
        if (typeof data.fields === 'object') {
          if ('pages' in data.fields && Array.isArray(data.fields.pages)) {
            // Multi-page format — flatten all page elements into one list
            elements = data.fields.pages.flatMap((p: any) => p.elements || []);
          } else if ('elements' in data.fields) {
            elements = data.fields.elements;
          } else if (Array.isArray(data.fields)) {
            elements = data.fields;
          }
        }
        setSurvey({
          ...data,
          fields: { elements }
        });
      } else {
        toast.error('Failed to load survey');
        router.push('/dashboard');
      }
    } catch (error) {
      console.error('Failed to fetch survey:', error);
      toast.error('Failed to load survey');
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
      toast.warning('Question title is required');
      return;
    }

    if ((fieldForm.type === 'radiogroup' || fieldForm.type === 'checkbox' || fieldForm.type === 'dropdown') &&
        (!fieldForm.choices || fieldForm.choices.length === 0 || !fieldForm.choices.some(c => typeof c === 'string' ? c.trim() : c.text?.trim()))) {
      toast.warning('Multiple choice questions must have at least one option');
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
      toast.warning('Survey title is required');
      return;
    }

    if (survey.fields.elements.length === 0) {
      toast.warning('Survey must have at least one question');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...survey,
        status: publish ? 'published' : survey.status,
      };

      const res = await apiFetch(
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
        toast.error(error.error || 'Failed to save survey');
      }
    } catch (error) {
      console.error('Failed to save survey:', error);
      toast.error('Failed to save survey');
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
            className="px-4 py-2 border border-white/10 dark:border-white/10:bg-surface-elevated dark:hover:bg-surface-elevated transition"
          >
            Cancel
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Builder Panel */}
          <div className="space-y-6">
            <div className="bg-white dark:bg-surface-elevated p-6 border border-white/10 dark:border-white/10">
              <h2 className="text-xl font-semibold mb-4">Survey Details</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Title *</label>
                  <input
                    type="text"
                    value={survey.title}
                    onChange={(e) => setSurvey({ ...survey, title: e.target.value })}
                    placeholder="Survey title"
                    className="w-full px-4 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-surface"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea
                    value={survey.description}
                    onChange={(e) => setSurvey({ ...survey, description: e.target.value })}
                    placeholder="Optional description"
                    rows={3}
                    className="w-full px-4 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-surface"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white dark:bg-surface-elevated p-6 border border-white/10 dark:border-white/10">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Questions ({survey.fields.elements.length})</h2>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  onClick={() => openFieldForm('text')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Text
                </button>
                <button
                  onClick={() => openFieldForm('comment')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Comment
                </button>
                <button
                  onClick={() => openFieldForm('radiogroup')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Radio
                </button>
                <button
                  onClick={() => openFieldForm('checkbox')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Checkbox
                </button>
                <button
                  onClick={() => openFieldForm('dropdown')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Dropdown
                </button>
                <button
                  onClick={() => openFieldForm('rating')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Rating
                </button>
                <button
                  onClick={() => openFieldForm('boolean')}
                  className="px-3 py-2 bg-imajin-orange text-primary text-sm hover:brightness-110 transition"
                >
                  + Yes/No
                </button>
              </div>

              {/* Field form for NEW questions — renders above the list */}
              {showFieldForm && editingFieldIndex === null && (
                <FieldFormPanel
                  fieldForm={fieldForm}
                  setFieldForm={setFieldForm}
                  onSave={saveField}
                  onCancel={() => { setShowFieldForm(false); setEditingFieldIndex(null); }}
                  isEditing={false}
                />
              )}

              <div className="space-y-2">
                {survey.fields.elements.length === 0 ? (
                  <div className="text-center py-8 text-secondary text-sm">
                    No questions yet. Add a question using the buttons above.
                  </div>
                ) : (
                  survey.fields.elements.map((field, index) => (
                    <div key={field.name}>
                      {/* Inline edit form — replaces the question card when editing */}
                      {showFieldForm && editingFieldIndex === index ? (
                        <FieldFormPanel
                          fieldForm={fieldForm}
                          setFieldForm={setFieldForm}
                          onSave={saveField}
                          onCancel={() => { setShowFieldForm(false); setEditingFieldIndex(null); }}
                          isEditing={true}
                        />
                      ) : (
                        <div className="p-3 border border-white/10 dark:border-white/10 bg-surface-elevated flex items-center justify-between">
                          <div className="flex-1">
                            <div className="font-medium text-sm">
                              {field.title}
                              {field.isRequired && <span className="text-error ml-1">*</span>}
                            </div>
                            <div className="text-xs text-secondary">
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
                              className="px-2 py-1 border border-white/10 dark:border-white/10 text-xs disabled:opacity-30"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => moveField(index, 'down')}
                              disabled={index === survey.fields.elements.length - 1}
                              className="px-2 py-1 border border-white/10 dark:border-white/10 text-xs disabled:opacity-30"
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => editField(index)}
                              className="px-2 py-1 border border-white/10 dark:border-white/10 text-xs:bg-surface-elevated dark:hover:bg-surface-elevated"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => deleteField(index)}
                              className="px-2 py-1 border border-error/20 dark:border-error/20 text-error text-xs:bg-error/10 dark:hover:bg-red-900/20"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => saveSurvey(false)}
                disabled={saving}
                className="flex-1 px-6 py-3 border border-white/10 dark:border-white/10 font-semibold:bg-surface-elevated dark:hover:bg-surface-elevated transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save as Draft'}
              </button>
              <button
                onClick={() => saveSurvey(true)}
                disabled={saving}
                className="flex-1 px-6 py-3 bg-imajin-orange text-primary font-semibold hover:brightness-110 transition disabled:opacity-50"
              >
                {saving ? 'Publishing...' : 'Publish Survey'}
              </button>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="lg:sticky lg:top-6 h-fit">
            <div className="bg-white dark:bg-surface-elevated p-6 border border-white/10 dark:border-white/10">
              <h2 className="text-xl font-semibold mb-4">Live Preview</h2>

              <div className="border-t border-white/10 dark:border-white/10 pt-4">
                <h3 className="text-2xl font-bold mb-2">
                  {survey.title || 'Untitled Survey'}
                </h3>
                {survey.description && (
                  <p className="text-muted dark:text-secondary mb-6">
                    {survey.description}
                  </p>
                )}

                {survey.fields.elements.length === 0 ? (
                  <div className="text-center py-12 text-secondary text-sm">
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
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-imajin-purple" /></div>}>
      <CreateSurveyContent />
    </Suspense>
  );
}
