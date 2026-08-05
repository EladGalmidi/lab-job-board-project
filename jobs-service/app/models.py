from sqlalchemy import Column, String, Text
from sqlalchemy.sql import func
from sqlalchemy import DateTime
from .database import Base


class Job(Base):
    __tablename__ = "jobs"

    id           = Column(String(255), primary_key=True, index=True)
    title        = Column(String(200),  nullable=False)
    description  = Column(Text,         nullable=False)
    company      = Column(String(200),  nullable=False)
    location     = Column(String(200),  nullable=False)
    salary_range = Column(String(100),  nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
