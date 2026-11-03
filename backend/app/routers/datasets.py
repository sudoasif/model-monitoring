from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import ProjectContext, get_current_user, get_project_context, project_context_for_user
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import (
    Dataset,
    DatasetVersion,
    ModelVersion,
    Project,
    TrainingRun,
    User,
)
from app.schemas import DatasetOut, DatasetUpdate, DatasetVersionOut, SampleDatasetRequest
from app.services.audit import record_audit
from app.services.datasets import (
    SAMPLE_DATASETS,
    create_dataset_version,
    create_sample_version,
    ensure_unique_dataset_name,
    load_dataset_frame,
    serialize_dataset_version,
)
from app.services.rate_limit import limiter
from app.services.storage import storage
from app.utils import jsonable

router = APIRouter(tags=["datasets"])


def _dataset_for_version(db: Session, version_id: str) -> Dataset:
    version = db.get(DatasetVersion, version_id)
    if not version:
        raise NotFoundError("Dataset version not found")
    dataset = db.get(Dataset, version.dataset_id)
    if not dataset:
        raise NotFoundError("Dataset not found")
    return dataset


def _version_with_access(db: Session, user: User, version_id: str) -> tuple[DatasetVersion, Dataset, Project]:
    dataset = _dataset_for_version(db, version_id)
    project = db.get(Project, dataset.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    version = db.get(DatasetVersion, version_id)
    assert version is not None
    return version, dataset, project


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetOut])
def list_datasets(
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> list[DatasetOut]:
    datasets = db.scalars(
        select(Dataset).where(Dataset.project_id == ctx.project.id).order_by(Dataset.created_at.desc())
    ).all()
    result: list[DatasetOut] = []
    for dataset in datasets:
        versions = db.scalars(
            select(DatasetVersion)
            .where(DatasetVersion.dataset_id == dataset.id)
            .order_by(DatasetVersion.version.desc())
        ).all()
        result.append(
            DatasetOut(
                id=dataset.id,
                project_id=dataset.project_id,
                name=dataset.name,
                description=dataset.description,
                created_at=dataset.created_at,
                versions=[
                    DatasetVersionOut(**serialize_dataset_version(db, version)) for version in versions
                ],
            )
        )
    return result


@router.post("/projects/{project_id}/datasets/upload", response_model=DatasetVersionOut, status_code=201)
async def upload_dataset(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(default=""),
    description: str = Form(default=""),
    notes: str = Form(default=""),
    is_reference: bool = Form(default=False),
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> DatasetVersionOut:
    limiter.hit(f"upload:{ctx.workspace_ctx.user.id}", 20, 60)
    if ctx.project.status != "active":
        raise ValidationAppError("Archived projects cannot receive new datasets.")
    if not ctx.project.target_column:
        raise ValidationAppError("Set the project's target column before uploading a dataset.")
    filename = (file.filename or "dataset.csv").strip()
    if not filename.lower().endswith(".csv"):
        raise ValidationAppError("Only .csv files are supported.")
    if file.content_type and file.content_type not in {
        "text/csv",
        "application/csv",
        "text/plain",
        "application/vnd.ms-excel",
        "application/octet-stream",
    }:
        raise ValidationAppError("The uploaded file does not look like a CSV (unsupported content type).")
    size = 0
    chunks: list[bytes] = []
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.max_upload_bytes:
            raise ValidationAppError(
                f"The file exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB upload limit."
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise ValidationAppError("The uploaded file is empty.")
    dataset_name = name.strip() or Path(filename).stem[:160] or "Dataset"
    version = create_dataset_version(
        db,
        project=ctx.project,
        user=ctx.workspace_ctx.user,
        data=data,
        original_filename=filename,
        dataset_name=dataset_name,
        description=description.strip(),
        notes=notes.strip(),
        is_reference=is_reference,
    )
    record_audit(
        db,
        workspace_id=ctx.project.workspace_id,
        actor=ctx.workspace_ctx.user,
        action="dataset.uploaded",
        entity_type="dataset_version",
        entity_id=version.id,
        details={
            "project_id": ctx.project.id,
            "rows": version.row_count,
            "columns": version.column_count,
            "size_bytes": version.size_bytes,
            "content_hash": version.content_hash,
        },
        request=request,
    )
    db.commit()
    return DatasetVersionOut(**serialize_dataset_version(db, version))


@router.post("/projects/{project_id}/datasets/sample", response_model=DatasetVersionOut, status_code=201)
def create_sample_dataset(
    payload: SampleDatasetRequest,
    request: Request,
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> DatasetVersionOut:
    meta = SAMPLE_DATASETS.get(payload.sample_key)
    if not meta:
        raise NotFoundError("Sample dataset not found")
    if meta["task_type"] != ctx.project.task_type:
        raise ValidationAppError(
            f"This sample dataset is for {meta['task_type']} projects. Create a {meta['task_type']} project first."
        )
    if ctx.project.target_column and ctx.project.target_column != meta["target_column"]:
        raise ValidationAppError(
            f"This project's target is '{ctx.project.target_column}', but the sample uses "
            f"'{meta['target_column']}'. Create a project with the sample target column or upload your own CSV."
        )
    if not ctx.project.target_column:
        ctx.project.target_column = meta["target_column"]
    version = create_sample_version(
        db,
        project=ctx.project,
        user=ctx.workspace_ctx.user,
        key=payload.sample_key,
        shifted=payload.shifted,
        dataset_name=payload.name,
        is_reference=payload.is_reference or not payload.shifted,
    )
    record_audit(
        db,
        workspace_id=ctx.project.workspace_id,
        actor=ctx.workspace_ctx.user,
        action="dataset.sample_created",
        entity_type="dataset_version",
        entity_id=version.id,
        details={
            "sample_key": payload.sample_key,
            "shifted": payload.shifted,
            "rows": version.row_count,
            "simulated": True,
        },
        request=request,
    )
    db.commit()
    return DatasetVersionOut(**serialize_dataset_version(db, version))


@router.get("/datasets/{version_id}", response_model=DatasetVersionOut)
def get_dataset_version(
    version_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DatasetVersionOut:
    version, _dataset, _project = _version_with_access(db, user, version_id)
    return DatasetVersionOut(**serialize_dataset_version(db, version))


@router.get("/datasets/{version_id}/preview")
def preview_dataset(
    version_id: str,
    limit: int = Query(default=25, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    version, dataset, _project = _version_with_access(db, user, version_id)
    frame = load_dataset_frame(version)
    preview = frame.head(limit).astype(object)
    rows: list[dict[str, Any]] = []
    for _, row in preview.iterrows():
        rows.append({str(key): jsonable(value) for key, value in row.items()})
    return {
        "dataset_version_id": version.id,
        "dataset_name": dataset.name,
        "version": version.version,
        "columns": [str(column) for column in frame.columns],
        "dtypes": {str(column): str(dtype) for column, dtype in frame.dtypes.items()},
        "rows": rows,
        "total_rows": version.row_count,
        "returned_rows": len(rows),
        "note": "Preview values are raw dataset values. PII-like columns are excluded from model features and monitoring capture.",
    }


@router.get("/datasets/{version_id}/download")
def download_dataset(
    version_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    version, dataset, _project = _version_with_access(db, user, version_id)
    path = storage.materialize(version.storage_path)
    return FileResponse(
        path,
        media_type="text/csv",
        filename=f"{dataset.name.replace(' ', '_')}_v{version.version}.csv",
    )


@router.patch("/datasets/{version_id}", response_model=DatasetVersionOut)
def update_dataset(
    version_id: str,
    payload: DatasetUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DatasetVersionOut:
    version, dataset, project = _version_with_access(db, user, version_id)
    if payload.name is not None and payload.name.strip() != dataset.name:
        ensure_unique_dataset_name(db, project.id, payload.name.strip(), exclude_id=dataset.id)
        dataset.name = payload.name.strip()
    if payload.description is not None:
        dataset.description = payload.description.strip()
    if payload.notes is not None:
        version.notes = payload.notes.strip()
    if payload.is_reference is not None:
        if payload.is_reference:
            db.query(DatasetVersion).filter(
                DatasetVersion.dataset_id == dataset.id, DatasetVersion.is_reference.is_(True)
            ).update({DatasetVersion.is_reference: False})
        version.is_reference = payload.is_reference
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="dataset.updated",
        entity_type="dataset_version",
        entity_id=version.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return DatasetVersionOut(**serialize_dataset_version(db, version))


@router.delete("/datasets/{version_id}", status_code=204)
def delete_dataset_version(
    version_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    version, dataset, project = _version_with_access(db, user, version_id)
    from app.deps import project_context_for_user

    context = project_context_for_user(db, user, project.id)
    if not context.is_admin:
        raise ValidationAppError("Only workspace administrators can delete dataset versions.")
    used_by_model = db.scalar(select(ModelVersion.id).where(ModelVersion.dataset_version_id == version.id).limit(1))
    used_by_run = db.scalar(select(TrainingRun.id).where(TrainingRun.dataset_version_id == version.id).limit(1))
    if used_by_model or used_by_run:
        raise ConflictError(
            "This dataset version is referenced by a model version or training run. "
            "Keep it for lineage instead of deleting it."
        )
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="dataset.version_deleted",
        entity_type="dataset_version",
        entity_id=version.id,
        details={"dataset": dataset.name, "version": version.version},
        request=request,
    )
    remaining = int(
        db.scalar(select(func.count(DatasetVersion.id)).where(DatasetVersion.dataset_id == dataset.id)) or 0
    )
    db.delete(version)
    if remaining <= 1:
        db.delete(dataset)
    db.commit()
