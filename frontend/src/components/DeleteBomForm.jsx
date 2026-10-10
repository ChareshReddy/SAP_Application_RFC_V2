import React, { useState } from 'react';
import { Trash2, AlertTriangle, ArrowRight, X, Layers, Factory, Hash } from 'lucide-react';

export default function DeleteBomForm({ onSubmit, onCancel, initialValues = {} }) {
  const [formData, setFormData] = useState({
    material: initialValues.material || '',
    plant: initialValues.plant || '',
    alternativeBom: initialValues.alternativeBom || '',
    bomUsage: initialValues.bomUsage || '1'
  });

  const [validationError, setValidationError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (validationError) setValidationError('');
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: false }));
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    const errors = {};
    const requiredFields = ['material', 'plant', 'alternativeBom', 'bomUsage'];

    requiredFields.forEach((field) => {
      if (!String(formData[field] || '').trim()) {
        errors[field] = true;
      }
    });

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setValidationError('Please fill in all required fields to proceed.');
      return;
    }

    const material = formData.material.trim().toUpperCase();
    const plant = formData.plant.trim().toUpperCase();
    const alternativeBom = formData.alternativeBom.trim();
    const bomUsage = formData.bomUsage.trim();

    setValidationError('');
    setFieldErrors({});

    onSubmit({
      material,
      plant,
      alternativeBom,
      bomUsage
    });
  };

  return (
    <div className="sap-structured-form-card delete-card">
      <div className="sap-form-header">
        <div className="sap-form-header-title">
          <div className="sap-form-header-icon delete-icon">
            <Trash2 size={18} />
          </div>
          <div>
            <h4>Delete Bill of Materials (RFC / BAPI)</h4>
            <p>Specify the exact BOM identifiers for permanent deletion.</p>
          </div>
        </div>
      </div>

      <div className="sap-form-alert sap-form-alert-warning">
        <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong>Destructive Operation:</strong> Deleting a BOM removes all component linkages in the specified plant. A safety confirmation check will be required prior to execution.
        </div>
      </div>

      {validationError && (
        <div className="sap-form-alert sap-form-alert-error">
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>{validationError}</span>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="sap-form-grid">
          <div className="sap-form-group">
            <label htmlFor="delMaterial">
              Material <span className="required-star">*</span>
            </label>
            <div className="sap-form-input-wrapper">
              <Layers size={14} className="input-icon" />
              <input
                id="delMaterial"
                type="text"
                placeholder="e.g. A1BH0214C"
                value={formData.material}
                onChange={(e) => handleChange('material', e.target.value)}
                className={`sap-form-input ${fieldErrors.material ? 'input-error' : ''}`}
              />
            </div>
          </div>

          <div className="sap-form-group">
            <label htmlFor="delPlant">
              Plant <span className="required-star">*</span>
            </label>
            <div className="sap-form-input-wrapper">
              <Factory size={14} className="input-icon" />
              <input
                id="delPlant"
                type="text"
                placeholder="e.g. 1001"
                value={formData.plant}
                onChange={(e) => handleChange('plant', e.target.value)}
                className={`sap-form-input ${fieldErrors.plant ? 'input-error' : ''}`}
              />
            </div>
          </div>

          <div className="sap-form-group">
            <label htmlFor="delAlternativeBom">
              Alternative BOM <span className="required-star">*</span>
            </label>
            <div className="sap-form-input-wrapper">
              <Hash size={14} className="input-icon" />
              <input
                id="delAlternativeBom"
                type="text"
                placeholder="e.g. 2"
                value={formData.alternativeBom}
                onChange={(e) => handleChange('alternativeBom', e.target.value)}
                className={`sap-form-input ${fieldErrors.alternativeBom ? 'input-error' : ''}`}
              />
            </div>
          </div>

          <div className="sap-form-group">
            <label htmlFor="delBomUsage">
              BOM Usage <span className="required-star">*</span>
            </label>
            <div className="sap-form-input-wrapper">
              <Hash size={14} className="input-icon" />
              <input
                id="delBomUsage"
                type="text"
                placeholder="1"
                value={formData.bomUsage}
                onChange={(e) => handleChange('bomUsage', e.target.value)}
                className={`sap-form-input ${fieldErrors.bomUsage ? 'input-error' : ''}`}
              />
            </div>
          </div>
        </div>

        <div className="sap-form-actions">
          <button
            type="button"
            className="sap-btn sap-btn-secondary"
            onClick={onCancel}
          >
            <X size={15} />
            <span>Cancel</span>
          </button>

          <button
            type="submit"
            className="sap-btn sap-btn-danger"
          >
            <span>Proceed</span>
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
