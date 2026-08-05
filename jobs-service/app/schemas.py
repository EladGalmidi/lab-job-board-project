from datetime import datetime

from pydantic import BaseModel, Field


class JobCreate(BaseModel):
    title:        str           = Field(..., min_length=3,  max_length=200)
    description:  str           = Field(..., min_length=10)
    company:      str           = Field(..., min_length=2,  max_length=200)
    location:     str           = Field(..., min_length=2,  max_length=200)
    salary_range: str | None = Field(None, max_length=100)


class Job(JobCreate):
    id:         str
    created_at: datetime

    model_config = {"from_attributes": True}
